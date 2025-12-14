import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { LANGUAGE_OPTIONS, messages } from './translations'

const STORAGE_KEY = 'pmd_locale'
const FALLBACK_LOCALE = 'fr'

const LanguageContext = createContext({
  locale: FALLBACK_LOCALE,
  setLocale: () => {},
  t: (key) => key,
  languages: LANGUAGE_OPTIONS,
})

const getBrowserLocale = () => {
  if (typeof navigator === 'undefined') return null
  const { language, languages } = navigator
  return language ?? languages?.[0] ?? null
}

const normalizeLocale = (value) => {
  if (!value) return null
  const lower = value.toLowerCase()
  const direct = LANGUAGE_OPTIONS.find((option) => option.code.toLowerCase() === lower)
  if (direct) return direct.code
  if (lower.startsWith('fr')) return 'fr'
  if (lower.startsWith('zh')) return 'zh-Hant'
  if (lower.startsWith('en')) return 'en'
  return null
}

const getInitialLocale = () => {
  if (typeof window !== 'undefined') {
    const stored = normalizeLocale(window.localStorage.getItem(STORAGE_KEY))
    if (stored) return stored
  }
  const envLocale = normalizeLocale(import.meta.env.VITE_DEFAULT_LOCALE)
  if (envLocale) return envLocale
  const browser = normalizeLocale(getBrowserLocale())
  if (browser) return browser
  return FALLBACK_LOCALE
}

const interpolate = (template, variables = {}) =>
  template.replace(/{{(.*?)}}/g, (match, key) => {
    const trimmed = key.trim()
    return Object.prototype.hasOwnProperty.call(variables, trimmed) ? String(variables[trimmed]) : match
  })

const getMessageValue = (locale, key) => {
  const source = messages[locale]
  if (!source) return null
  return key.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : null), source)
}

export const translateMessage = (locale, key, variables) => {
  const primary = getMessageValue(locale, key)
  const fallback = locale === 'en' ? null : getMessageValue('en', key)
  const value = primary ?? fallback
  if (typeof value !== 'string') return key
  if (!variables) return value
  return interpolate(value, variables)
}

export function LanguageProvider({ children }) {
  const [locale, setLocaleState] = useState(getInitialLocale)

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale
    }
  }, [locale])

  const setLocale = useCallback((next) => {
    const normalized = normalizeLocale(next)
    if (!normalized) return
    setLocaleState(normalized)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, normalized)
    }
  }, [])

  const translate = useCallback((key, variables) => translateMessage(locale, key, variables), [locale])

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t: translate,
      languages: LANGUAGE_OPTIONS,
    }),
    [locale, setLocale, translate],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export const useTranslation = () => useContext(LanguageContext)
