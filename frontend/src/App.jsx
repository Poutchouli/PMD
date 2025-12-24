import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Globe,
  LogOut,
  Plus,
  RefreshCw,
  Server,
  Upload,
  X,
} from 'lucide-react'
import LoginScreen from './components/auth/LoginScreen'
import LanguageSelector from './components/common/LanguageSelector'
import TargetDetailsPage from './components/details/TargetDetailsPage'
import { useTranslation } from './i18n/LanguageProvider'
import { formatLatency, formatPercent } from './utils/formatters'
import { bucketSecondsForWindow } from './utils/insights'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:6666'
const POLL_INTERVAL = 3000
const DASHBOARD_INSIGHTS_REFRESH_MS = 60_000

const createEmptyTargetForm = () => ({ ip: '', frequency: 5, url: '', notes: '' })

function App() {
  const { t } = useTranslation()
  const [view, setView] = useState('dashboard')
  const [targets, setTargets] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [form, setForm] = useState(() => createEmptyTargetForm())
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [token, setToken] = useState(() => {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem('pmd_token')
  })
  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [loginError, setLoginError] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [insightsMap, setInsightsMap] = useState({})
  const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false)
  const [isDownloadingTargetsCsv, setIsDownloadingTargetsCsv] = useState(false)
  const [isImportingTargets, setIsImportingTargets] = useState(false)
  const [importFeedback, setImportFeedback] = useState('')
  const [importErrors, setImportErrors] = useState([])
  const [importError, setImportError] = useState('')
  const [importFilename, setImportFilename] = useState('')
  const [detailRefreshSignal, setDetailRefreshSignal] = useState(0)

  const insightsMapRef = useRef({})
  const insightFreshnessRef = useRef({})
  const lastDashboardInsightsRef = useRef(0)
  const importFileRef = useRef(null)
  const isAuthenticated = Boolean(token)

  const currentTarget = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? null,
    [targets, selectedId],
  )

  const logout = useCallback(
    (message) => {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('pmd_token')
      }
      setToken(null)
      setView('dashboard')
      setSelectedId(null)
      setTargets([])
      setInsightsMap({})
      insightsMapRef.current = {}
      insightFreshnessRef.current = {}
      if (message) {
        setError(message)
      }
    },
    [],
  )

  const handleLoginSubmit = async (event) => {
    event.preventDefault()
    if (isLoggingIn) return
    setIsLoggingIn(true)
    setLoginError('')
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginForm.username.trim(),
          password: loginForm.password,
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.access_token) {
        throw new Error(payload?.detail ?? t('auth.invalidCredentials'))
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('pmd_token', payload.access_token)
      }
      setToken(payload.access_token)
      setLoginForm({ username: '', password: '' })
      setLoginError('')
      setError('')
    } catch (err) {
      setLoginError(err.message ?? t('auth.genericError'))
    } finally {
      setIsLoggingIn(false)
      setLoginForm((prev) => ({ ...prev, password: '' }))
    }
  }

  const apiCall = useCallback(
    async (endpoint, options = {}) => {
      if (!token) {
        throw new Error(t('auth.notAuthenticated'))
      }
      try {
        const headers = new Headers(options.headers ?? {})
        headers.set('Authorization', `Bearer ${token}`)
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...options,
          headers,
        })
        if (response.status === 401) {
          logout(t('alerts.sessionExpired'))
          throw new Error(t('alerts.sessionExpired'))
        }
        if (!response.ok) {
          let detail
          try {
            const data = await response.json()
            detail = data?.detail
          } catch (err) {
            // ignore JSON errors
          }
          throw new Error(detail ?? `HTTP ${response.status}`)
        }
        setError('')
        if (response.status === 204) return null
        return await response.json()
      } catch (err) {
        console.error('API Error:', err)
        if (!String(err.message).includes(t('alerts.sessionExpired'))) {
          setError(t('alerts.apiUnavailable'))
        }
        throw err
      }
    },
    [logout, t, token],
  )

  const updateInsightsState = useCallback((targetId, data) => {
    setInsightsMap((prev) => {
      const next = { ...prev, [targetId]: data }
      insightsMapRef.current = next
      return next
    })
  }, [])

  const fetchInsights = useCallback(
    async (targetId, { windowMinutes = 60, bucketSeconds = 60 } = {}) => {
      const params = new URLSearchParams()
      params.set('window_minutes', String(windowMinutes))
      params.set('bucket_seconds', String(bucketSeconds))
      return apiCall(`/targets/${targetId}/insights?${params.toString()}`)
    },
    [apiCall],
  )

  const updateInsights = useCallback(
    async (targetId, options = {}, force = false) => {
      const now = Date.now()
      const last = insightFreshnessRef.current[targetId] ?? 0
      const freshnessWindow = DASHBOARD_INSIGHTS_REFRESH_MS
      if (!force && now - last < freshnessWindow && insightsMapRef.current[targetId]) {
        return insightsMapRef.current[targetId]
      }
      const data = await fetchInsights(targetId, options)
      insightFreshnessRef.current[targetId] = now
      updateInsightsState(targetId, data)
      return data
    },
    [fetchInsights, updateInsightsState],
  )

  const refreshDashboardInsights = useCallback(
    async (targetList) => {
      if (!targetList.length) return
      const now = Date.now()
      if (now - lastDashboardInsightsRef.current < DASHBOARD_INSIGHTS_REFRESH_MS) return
      lastDashboardInsightsRef.current = now
      await Promise.all(
        targetList.map((target) =>
          updateInsights(
            target.id,
            { windowMinutes: 60, bucketSeconds: bucketSecondsForWindow(60) },
            false,
          ).catch(() => null),
        ),
      )
    },
    [updateInsights],
  )

  const loadTargets = useCallback(async () => {
    if (!token) return
    try {
      const result = await apiCall('/targets/')
      result.sort((a, b) => a.id - b.id)
      setTargets(result)
      await refreshDashboardInsights(result)
      if (selectedId && !result.some((target) => target.id === selectedId)) {
        setSelectedId(null)
        setView('dashboard')
      }
    } catch (err) {
      // handled in apiCall
    }
  }, [apiCall, refreshDashboardInsights, selectedId, token])

  const handleRefresh = useCallback(async () => {
    if (!token) return
    if (view === 'details' && selectedId) {
      setDetailRefreshSignal(Date.now())
    } else {
      await loadTargets()
    }
  }, [loadTargets, selectedId, token, view])

  useEffect(() => {
    if (!token) return
    loadTargets()
  }, [loadTargets, token])

  useEffect(() => {
    if (!token) return undefined
    const interval = setInterval(() => {
      if (view === 'dashboard') {
        loadTargets()
      }
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [loadTargets, token, view])

  const handleCreateSubmit = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    try {
      const payload = {
        ip: form.ip.trim(),
        frequency: Number(form.frequency),
      }
      const trimmedUrl = form.url.trim()
      const notesValue = form.notes.trim()
      if (trimmedUrl) {
        payload.url = trimmedUrl
      }
      if (notesValue) {
        payload.notes = notesValue
      }
      await apiCall('/targets/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setForm(createEmptyTargetForm())
      await loadTargets()
      setView('dashboard')
    } catch (err) {
      // already surfaced
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSelectTarget = (id) => {
    setSelectedId(id)
    setView('details')
    setDetailRefreshSignal(Date.now())
  }

  const handleTargetUpdated = useCallback((updatedTarget) => {
    setTargets((prev) => prev.map((target) => (target.id === updatedTarget.id ? updatedTarget : target)))
  }, [])

  const handleToggleTarget = useCallback(
    async (target) => {
      if (!target) return
      setIsBusy(true)
      try {
        const action = target.is_active ? 'pause' : 'resume'
        await apiCall(`/targets/${target.id}/${action}`, { method: 'POST' })
        await loadTargets()
        setSelectedId(target.id)
        setDetailRefreshSignal(Date.now())
      } catch (err) {
        // handled upstream
      } finally {
        setIsBusy(false)
      }
    },
    [apiCall, loadTargets],
  )

  const handleDeleteTarget = useCallback(
    async (target) => {
      if (!target) return
      const confirmDelete = window.confirm(t('details.deleteConfirm'))
      if (!confirmDelete) return
      setIsBusy(true)
      try {
        await apiCall(`/targets/${target.id}`, { method: 'DELETE' })
        await loadTargets()
        setView('dashboard')
        setSelectedId(null)
        setInsightsMap((prev) => {
          const next = { ...prev }
          delete next[target.id]
          insightsMapRef.current = next
          return next
        })
      } catch (err) {
        // handled upstream
      } finally {
        setIsBusy(false)
      }
    },
    [apiCall, loadTargets, t],
  )

  const downloadCsvFile = useCallback(
    async (endpoint, filename, setLoading) => {
      if (!token) return
      setLoading(true)
      try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        if (response.status === 401) {
          logout(t('alerts.sessionExpired'))
          throw new Error(t('alerts.sessionExpired'))
        }
        if (!response.ok) {
          let detail
          try {
            const data = await response.json()
            detail = data?.detail
          } catch (err) {
            // ignore parse errors
          }
          throw new Error(detail ?? `HTTP ${response.status}`)
        }
        const blob = await response.blob()
        const downloadUrl = window.URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = downloadUrl
        link.download = filename
        document.body.appendChild(link)
        link.click()
        link.remove()
        window.URL.revokeObjectURL(downloadUrl)
      } finally {
        setLoading(false)
      }
    },
    [logout, t, token],
  )

  const handleDownloadTemplate = useCallback(async () => {
    try {
      await downloadCsvFile('/targets/import/template', 'pingmedaddy-targets-template.csv', setIsDownloadingTemplate)
    } catch (err) {
      setImportError(err?.message ?? t('create.import.error'))
    }
  }, [downloadCsvFile, t])

  const handleDownloadTargetsCsv = useCallback(async () => {
    try {
      await downloadCsvFile('/targets/export', 'pingmedaddy-targets.csv', setIsDownloadingTargetsCsv)
    } catch (err) {
      setImportError(err?.message ?? t('create.import.error'))
    }
  }, [downloadCsvFile, t])

  const handleImportCsv = useCallback(async () => {
    if (!importFileRef.current?.files?.length) {
      setImportFeedback('')
      setImportErrors([])
      setImportError(t('create.import.noFile'))
      return
    }
    const file = importFileRef.current.files[0]
    setIsImportingTargets(true)
    setImportFeedback('')
    setImportErrors([])
    setImportError('')
    const formData = new FormData()
    formData.append('file', file)
    try {
      const response = await fetch(`${API_BASE_URL}/targets/import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      })
      if (response.status === 401) {
        logout(t('alerts.sessionExpired'))
        throw new Error(t('alerts.sessionExpired'))
      }
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.detail ?? `HTTP ${response.status}`)
      }
      setImportFeedback(
        t('create.import.result', {
          created: payload?.created ?? 0,
          skipped: payload?.skipped_existing ?? 0,
          errors: payload?.errors?.length ?? 0,
        }),
      )
      if (Array.isArray(payload?.errors)) {
        setImportErrors(payload.errors)
      }
      await loadTargets()
    } catch (err) {
      setImportError(err?.message ?? t('create.import.error'))
    } finally {
      if (importFileRef.current) {
        importFileRef.current.value = ''
      }
      setImportFilename('')
      setIsImportingTargets(false)
    }
  }, [loadTargets, logout, t, token])

  if (!isAuthenticated) {
    return (
      <LoginScreen
        form={loginForm}
        onChange={setLoginForm}
        onSubmit={handleLoginSubmit}
        error={loginError}
        isLoading={isLoggingIn}
      />
    )
  }

  return (
    <div className="bg-slate-50 text-slate-800 font-display min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setView('dashboard')
              setSelectedId(null)
            }}
            className="flex items-center gap-2 cursor-pointer"
          >
            <div className="bg-slate-800 text-white p-1.5 rounded-md">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xl font-bold tracking-tight text-slate-800">
                PingMeDaddy <span className="text-slate-400 font-normal text-sm">{t('header.analytics')}</span>
              </p>
            </div>
          </button>
          <div className="flex items-center gap-2">
            <LanguageSelector />
            <button
              type="button"
              onClick={handleRefresh}
              className="p-2 text-slate-400 hover:text-slate-600 transition-colors rounded-full hover:bg-slate-100"
              title={t('header.refreshTitle')}
              aria-label={t('header.refreshTitle')}
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => logout()}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-full hover:bg-slate-50"
              aria-label={t('header.logout')}
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">{t('header.logout')}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-grow max-w-7xl mx-auto px-4 py-8 w-full">
        {error && (
          <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4 text-red-700 flex items-center justify-between shadow-sm rounded-r">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5" />
              <div>
                <p className="font-bold">{t('alerts.connectionTitle')}</p>
                <p className="text-sm">{error}</p>
              </div>
            </div>
            <button type="button" onClick={() => setError('')} className="text-red-400 hover:text-red-600">
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        {view === 'dashboard' && (
          <section className="fade-in" aria-live="polite">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <div>
                <h2 className="text-2xl font-semibold text-slate-800">{t('dashboard.title')}</h2>
                <p className="text-slate-500 text-sm mt-1">{t('dashboard.subtitle')}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setView('create')
                  setForm(createEmptyTargetForm())
                }}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-white px-4 py-2.5 rounded-md shadow-sm transition-all text-sm font-medium"
              >
                <Plus className="w-4 h-4" /> {t('dashboard.addTarget')}
              </button>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-4 w-24">{t('dashboard.table.state')}</th>
                      <th className="px-6 py-4">{t('dashboard.table.address')}</th>
                      <th className="px-6 py-4">{t('dashboard.table.frequency')}</th>
                      <th className="px-6 py-4">{t('dashboard.table.lastActivity')}</th>
                      <th className="px-6 py-4 text-right">{t('dashboard.table.action')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {targets.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-12 text-center">
                          <div className="flex flex-col items-center text-slate-500 gap-3">
                            <Server className="w-10 h-10 text-slate-300" />
                            <p>{t('dashboard.emptyState')}</p>
                          </div>
                        </td>
                      </tr>
                    )}
                    {targets.map((target) => {
                      const rowInsights = insightsMap[target.id]
                      return (
                        <tr
                          key={target.id}
                          className={`hover:bg-slate-50 cursor-pointer border-l-4 transition-colors ${target.is_active ? 'border-l-emerald-500' : 'border-l-transparent'}`}
                          onClick={() => handleSelectTarget(target.id)}
                        >
                          <td className="px-6 py-4">
                            {target.is_active ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100 uppercase tracking-wide">
                                {t('dashboard.statusActive')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200 uppercase tracking-wide">
                                {t('dashboard.statusPaused')}
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <div className="font-bold text-slate-700 text-base flex items-center gap-2">
                              <span>{target.ip}</span>
                              {target.url && (
                                <a
                                  href={target.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-emerald-600 hover:text-emerald-700 text-xs font-semibold inline-flex items-center gap-1"
                                  onClick={(event) => event.stopPropagation()}
                                  title={t('dashboard.openInterface')}
                                  aria-label={t('dashboard.openInterface')}
                                >
                                  {t('dashboard.openInterface')}
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 mt-1">
                              {rowInsights
                                ? `${formatLatency(rowInsights.latency_avg_ms)} • ${t('insights.cards.uptime')} ${formatPercent(rowInsights.uptime_percent)}`
                                : t('dashboard.metricsLoading')}
                            </p>
                          </td>
                          <td className="px-6 py-4 text-slate-500 font-mono text-xs">{target.frequency}s</td>
                          <td className="px-6 py-4 text-slate-400 text-xs">
                            {new Date(target.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <ChevronRight className="w-5 h-5 text-slate-300 inline-block" />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {view === 'create' && (
          <section className="fade-in max-w-xl mx-auto mt-8">
            <button
              type="button"
              onClick={() => setView('dashboard')}
              className="mb-6 flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors w-fit group"
            >
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
              <span className="text-sm font-medium">{t('create.back')}</span>
            </button>
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-8">
              <h2 className="text-xl font-semibold text-slate-800 mb-6">{t('create.title')}</h2>
              <form onSubmit={handleCreateSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">{t('create.addressLabel')}</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Globe className="w-4 h-4 text-slate-400" />
                    </div>
                    <input
                      type="text"
                      className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-md focus:ring-2 focus:ring-slate-200 focus:border-slate-400 outline-none transition-all"
                      placeholder={t('create.addressPlaceholder')}
                      value={form.ip}
                      onChange={(event) => setForm((prev) => ({ ...prev, ip: event.target.value }))}
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">{t('create.frequencyLabel')}</label>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min="1"
                      max="60"
                      value={form.frequency}
                      onChange={(event) => setForm((prev) => ({ ...prev, frequency: Number(event.target.value) }))}
                      className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-800"
                    />
                    <span className="font-mono font-medium text-slate-800 bg-slate-100 py-1 px-2 rounded min-w-[3rem] text-center">
                      {form.frequency}s
                    </span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">{t('create.urlLabel')}</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <ExternalLink className="w-4 h-4 text-slate-400" />
                    </div>
                    <input
                      type="url"
                      className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-md focus:ring-2 focus:ring-slate-200 focus:border-slate-400 outline-none transition-all"
                      placeholder={t('create.urlPlaceholder')}
                      value={form.url}
                      onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">{t('create.notesLabel')}</label>
                  <textarea
                    className="w-full border border-slate-300 rounded-md px-3 py-2.5 text-sm focus:ring-2 focus:ring-slate-200 focus:border-slate-400 outline-none transition-all resize-none h-28"
                    placeholder={t('create.notesPlaceholder')}
                    value={form.notes}
                    onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                  />
                </div>
                <div className="pt-4 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setView('dashboard')}
                    className="flex-1 px-4 py-2.5 border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 font-medium text-sm transition-colors"
                  >
                    {t('create.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1 px-4 py-2.5 bg-slate-800 text-white rounded-md hover:bg-slate-700 font-medium text-sm shadow-sm transition-all disabled:opacity-60"
                  >
                    {isSubmitting ? t('create.submitting') : t('create.submit')}
                  </button>
                </div>
              </form>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6 mt-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-slate-800 font-semibold">
                    <FileSpreadsheet className="w-4 h-4" />
                    <span>{t('create.import.title')}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{t('create.import.subtitle')}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadTemplate}
                    disabled={isDownloadingTemplate}
                    className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-50 transition disabled:opacity-60"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {isDownloadingTemplate ? t('create.import.downloading') : t('create.import.template')}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadTargetsCsv}
                    disabled={isDownloadingTargetsCsv}
                    className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition disabled:opacity-60"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {isDownloadingTargetsCsv ? t('create.import.downloading') : t('create.import.current')}
                  </button>
                </div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] items-center">
                <label className="flex items-center gap-3 border border-dashed border-slate-300 rounded-md px-4 py-3 bg-slate-50 hover:border-slate-400 cursor-pointer">
                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    onChange={(event) => {
                      setImportFilename(event.target.files?.[0]?.name ?? '')
                      setImportFeedback('')
                      setImportErrors([])
                      setImportError('')
                    }}
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-slate-700">{importFilename || t('create.import.placeholder')}</span>
                    <span className="text-xs text-slate-500">{t('create.import.hint')}</span>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={handleImportCsv}
                  disabled={isImportingTargets}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-60"
                >
                  <Upload className="w-4 h-4" />
                  {isImportingTargets ? t('create.import.uploading') : t('create.import.cta')}
                </button>
              </div>
              {importFeedback && <p className="text-sm text-emerald-700 mt-3">{importFeedback}</p>}
              {importError && <p className="text-sm text-red-600 mt-2">{importError}</p>}
              {importErrors.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-red-600">{t('create.import.errorsTitle')}</p>
                  <ul className="mt-1 space-y-1 text-xs text-red-700 list-disc list-inside">
                    {importErrors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        )}

        {view === 'details' && currentTarget && (
          <TargetDetailsPage
            target={currentTarget}
            token={token}
            apiCall={apiCall}
            onBack={() => {
              setView('dashboard')
              setSelectedId(null)
            }}
            onTargetUpdate={handleTargetUpdated}
            onTargetDelete={handleDeleteTarget}
            onToggleTarget={handleToggleTarget}
            refreshSignal={detailRefreshSignal}
            isBusy={isBusy}
          />
        )}
      </main>
    </div>
  )
}

export default App
