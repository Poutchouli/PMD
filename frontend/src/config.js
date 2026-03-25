/**
 * Configuration du frontend PMD.
 * Les variables d'environnement sont injectées par Vite au build time.
 */

const env = {
  API_PORT: import.meta.env.VITE_API_PORT || '6666',
  HUB_API_PORT: import.meta.env.VITE_HUB_API_PORT || '8000',
  HUB_FRONTEND_PORT: import.meta.env.VITE_HUB_FRONTEND_PORT || '80',
  APP_SLUG: import.meta.env.VITE_APP_SLUG || 'pmd',
}

const getHost = () => {
  if (typeof window !== 'undefined') {
    return window.location.hostname
  }
  return 'localhost'
}

const getProtocol = () => {
  if (typeof window !== 'undefined') {
    return window.location.protocol
  }
  return 'http:'
}

const isHttps = () => getProtocol() === 'https:'

const config = {
  appSlug: env.APP_SLUG,

  get apiUrl() {
    if (isHttps()) {
      return window.location.origin
    }
    return `http://${getHost()}:${env.API_PORT}`
  },

  get hubApiUrl() {
    if (isHttps()) {
      return `${window.location.origin}/hub`
    }
    return `http://${getHost()}:${env.HUB_API_PORT}`
  },

  get hubFrontendUrl() {
    return `http://${getHost()}:${env.HUB_FRONTEND_PORT}`
  },

  storageKeys: {
    accessToken: 'pmd_access_token',
    refreshToken: 'pmd_refresh_token',
    theme: 'theme',
    preferences: 'user_preferences',
  },
}

export default config
export { env }
