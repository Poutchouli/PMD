import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useConfig } from './ConfigContext'
import config from '../config'

const AuthContext = createContext(null)

function getHubApiUrl(configHubApiUrl) {
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return `${window.location.origin}/hub`
  }
  return configHubApiUrl
}

function decodeToken(token) {
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const appConfig = useConfig()
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem(config.storageKeys.accessToken))

  const hubApiUrl = useMemo(() => getHubApiUrl(appConfig.hubApiUrl), [appConfig.hubApiUrl])

  // Decode token on load / change
  useEffect(() => {
    if (token) {
      const decoded = decodeToken(token)
      if (decoded && decoded.exp && decoded.exp > Math.floor(Date.now() / 1000)) {
        setUser(decoded)
      } else {
        localStorage.removeItem(config.storageKeys.accessToken)
        localStorage.removeItem(config.storageKeys.refreshToken)
        setToken(null)
        setUser(null)
      }
    }
  }, [token])

  // Handle callback from Hub (token in URL params)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const accessToken = urlParams.get('token') || urlParams.get('access_token')
    const refreshToken = urlParams.get('refresh_token')
    const error = urlParams.get('error')

    if (accessToken) {
      localStorage.setItem(config.storageKeys.accessToken, accessToken)
      setToken(accessToken)
      if (refreshToken) {
        localStorage.setItem(config.storageKeys.refreshToken, refreshToken)
      }
      window.history.replaceState({}, document.title, window.location.pathname)
    } else if (error) {
      console.error('Erreur authentification:', error)
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [])

  const login = useCallback(() => {
    const callbackUrl = encodeURIComponent(window.location.origin + window.location.pathname)
    window.location.href = `${appConfig.hubFrontendUrl}?callback=${callbackUrl}`
  }, [appConfig.hubFrontendUrl])

  const logout = useCallback(() => {
    localStorage.removeItem(config.storageKeys.accessToken)
    localStorage.removeItem(config.storageKeys.refreshToken)
    setToken(null)
    setUser(null)
    const callbackUrl = encodeURIComponent(window.location.origin + window.location.pathname)
    window.location.href = `${appConfig.hubFrontendUrl}?action=logout&callback=${callbackUrl}`
  }, [appConfig.hubFrontendUrl])

  // Refresh token
  const refreshingRef = useRef(false)

  const refreshAccessToken = useCallback(async () => {
    if (refreshingRef.current) return false
    const refreshToken = localStorage.getItem(config.storageKeys.refreshToken)
    if (!refreshToken) return false

    refreshingRef.current = true
    try {
      const response = await fetch(`${hubApiUrl}/api/auth/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (response.ok) {
        const data = await response.json()
        localStorage.setItem(config.storageKeys.accessToken, data.access_token)
        setToken(data.access_token)
        if (data.refresh_token) {
          localStorage.setItem(config.storageKeys.refreshToken, data.refresh_token)
        }
        return true
      } else {
        logout()
        return false
      }
    } catch {
      return false
    } finally {
      refreshingRef.current = false
    }
  }, [hubApiUrl, logout])

  // SSE for permission changes
  useEffect(() => {
    if (!user || !hubApiUrl) return

    let eventSource = null
    let reconnectTimeout = null

    const connectSSE = () => {
      try {
        eventSource = new EventSource(`${hubApiUrl}/api/events/stream`)

        eventSource.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'ping' || data.type === 'connected') return

            if (data.type === 'user_permissions_changed' && data.data?.username === user.sub) {
              await refreshAccessToken()
            }
            if (data.type === 'force_logout' && data.data?.username === user.sub) {
              logout()
            }
            if (data.type === 'apps_updated' && (data.data?.action === 'approved' || data.data?.action === 'created')) {
              await refreshAccessToken()
            }
          } catch {
            // ignore parse errors
          }
        }

        eventSource.onerror = () => {
          eventSource?.close()
          reconnectTimeout = setTimeout(connectSSE, 10000)
        }
      } catch {
        // ignore SSE creation errors
      }
    }

    connectSSE()

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      eventSource?.close()
    }
  }, [user, hubApiUrl, refreshAccessToken, logout])

  // Authenticated fetch with auto-refresh
  const authFetch = useCallback(
    async (url, options = {}) => {
      const fullUrl = url.startsWith('http') ? url : `${appConfig.apiUrl}${url}`
      const headers = { ...options.headers }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      let response = await fetch(fullUrl, { ...options, headers })

      if (response.status === 401 && token) {
        const refreshed = await refreshAccessToken()
        if (refreshed) {
          const newToken = localStorage.getItem(config.storageKeys.accessToken)
          headers['Authorization'] = `Bearer ${newToken}`
          response = await fetch(fullUrl, { ...options, headers })
        }
      }

      return response
    },
    [appConfig.apiUrl, token, refreshAccessToken],
  )

  const getAppRole = useCallback(() => {
    if (!user || !user.apps) return null
    return user.apps[appConfig.appSlug] || null
  }, [user, appConfig.appSlug])

  const hasMinRole = useCallback(
    (minRole) => {
      const roleHierarchy = { viewer: 1, user: 2, manager: 3, admin: 4 }
      const userRole = getAppRole()
      if (!userRole) return false
      return (roleHierarchy[userRole] || 0) >= (roleHierarchy[minRole] || 0)
    },
    [getAppRole],
  )

  const value = {
    user,
    token,
    isAuthenticated: !!user,
    login,
    logout,
    authFetch,
    getAppRole,
    hasMinRole,
    refreshAccessToken,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
