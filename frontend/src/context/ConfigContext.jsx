import React, { createContext, useContext, useState, useEffect } from 'react'
import config from '../config'

const ConfigContext = createContext(null)

export function ConfigProvider({ children }) {
  const [appConfig, setAppConfig] = useState({
    appSlug: config.appSlug,
    apiUrl: config.apiUrl,
    hubApiUrl: config.hubApiUrl,
    hubFrontendUrl: config.hubFrontendUrl,
    loaded: false,
    error: null,
  })

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch(`${config.apiUrl}/api/config`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const data = await response.json()

        const isHttps = window.location.protocol === 'https:'
        const hubApiUrl = isHttps
          ? `${window.location.origin}/hub`
          : data.hub_api_url || config.hubApiUrl
        const hubFrontendUrl = data.hub_frontend_url || config.hubFrontendUrl

        setAppConfig({
          appSlug: data.app_slug || config.appSlug,
          apiUrl: config.apiUrl,
          hubApiUrl,
          hubFrontendUrl,
          loaded: true,
          error: null,
        })
      } catch (error) {
        console.error('Erreur chargement config:', error)
        setAppConfig((prev) => ({
          ...prev,
          loaded: true,
          error: error.message,
        }))
      }
    }

    loadConfig()
  }, [])

  return <ConfigContext.Provider value={appConfig}>{children}</ConfigContext.Provider>
}

export function useConfig() {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider')
  }
  return context
}
