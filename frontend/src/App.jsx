import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Globe,
  LogOut,
  NotebookPen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react'
import LoginScreen from './components/auth/LoginScreen'
import StatsCard from './components/analytics/StatsCard'
import LatencyTimelineChart from './components/analytics/LatencyTimelineChart'
import LossTimelineChart from './components/analytics/LossTimelineChart'
import LogsTable from './components/logs/LogsTable'
import TraceroutePanel from './components/network/TraceroutePanel'
import LanguageSelector from './components/common/LanguageSelector'
import { useTranslation } from './i18n/LanguageProvider'
import { formatLatency, formatPercent, formatWindowLabel, formatWindowRange } from './utils/formatters'
import { buildTimelineData, bucketSecondsForWindow } from './utils/insights'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:6666'
const POLL_INTERVAL = 3000
const LOG_LIMIT = 50
const DASHBOARD_INSIGHTS_REFRESH_MS = 60_000
const DETAIL_INSIGHTS_REFRESH_MS = 15_000
const WINDOW_PRESETS = [
  { label: '15 min', value: 15 },
  { label: '1 h', value: 60 },
  { label: '4 h', value: 240 },
  { label: '24 h', value: 1440 },
]

const createEmptyTargetForm = () => ({ ip: '', frequency: 5, url: '', notes: '' })

function App() {
  const { t } = useTranslation()
  const [view, setView] = useState('dashboard')
  const [targets, setTargets] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [logs, setLogs] = useState([])
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
  const [isInsightsLoading, setIsInsightsLoading] = useState(false)
  const [insightWindow, setInsightWindow] = useState(60)
  const [traceResult, setTraceResult] = useState(null)
  const [traceError, setTraceError] = useState('')
  const [isTracing, setIsTracing] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [metadataDraft, setMetadataDraft] = useState({ url: '', notes: '' })
  const [isSavingMetadata, setIsSavingMetadata] = useState(false)
  const [metadataFeedback, setMetadataFeedback] = useState('')
  const insightsMapRef = useRef({})
  const insightFreshnessRef = useRef({})
  const lastDashboardInsightsRef = useRef(0)
  const isAuthenticated = Boolean(token)

  const currentTarget = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? null,
    [targets, selectedId],
  )
  const currentInsights = useMemo(() => (selectedId ? insightsMap[selectedId] ?? null : null), [insightsMap, selectedId])
  const timelineData = useMemo(() => buildTimelineData(currentInsights), [currentInsights])
  const windowLabel = useMemo(() => formatWindowLabel(insightWindow), [insightWindow])
  const reversedLogs = useMemo(() => [...logs].reverse(), [logs])
  const lastHop = useMemo(() => {
    const latest = reversedLogs.find((log) => !log.packet_loss && typeof log.hops === 'number')
    return typeof latest?.hops === 'number' ? latest.hops : null
  }, [reversedLogs])
  const sampleSummary = useMemo(() => {
    if (!currentInsights) return t('insights.waiting')
    return t('insights.sampleCount', { count: currentInsights.sample_count ?? 0 })
  }, [currentInsights, t])
  const insightCards = useMemo(
    () => [
      {
        label: t('insights.cards.uptime'),
        value: formatPercent(currentInsights?.uptime_percent),
        helper: currentInsights ? t('insights.lossCount', { count: currentInsights.loss_count ?? 0 }) : sampleSummary,
        accent: currentInsights?.uptime_percent && currentInsights.uptime_percent < 95 ? 'text-amber-600' : 'text-emerald-600',
      },
      {
        label: t('insights.cards.latencyAvg'),
        value: formatLatency(currentInsights?.latency_avg_ms),
        helper: t('insights.helpers.p50', { value: formatLatency(currentInsights?.latency_p50_ms) }),
      },
      {
        label: t('insights.cards.latencyMin'),
        value: formatLatency(currentInsights?.latency_min_ms),
        helper: t('insights.helpers.max', { value: formatLatency(currentInsights?.latency_max_ms) }),
      },
      {
        label: t('insights.cards.latencyP95'),
        value: formatLatency(currentInsights?.latency_p95_ms),
        helper: t('insights.helpers.p99', { value: formatLatency(currentInsights?.latency_p99_ms) }),
      },
      {
        label: t('insights.cards.window'),
        value: windowLabel,
        helper: sampleSummary,
      },
      {
        label: t('insights.cards.lastHop'),
        value: typeof lastHop === 'number' ? lastHop : '--',
        helper: t('insights.cards.lastHopHelper'),
      },
    ],
    [currentInsights, lastHop, sampleSummary, t, windowLabel],
  )
  const metadataChanged = useMemo(() => {
    if (!currentTarget) return false
    const currentUrl = currentTarget.url ?? ''
    const currentNotes = currentTarget.notes ?? ''
    return currentUrl !== metadataDraft.url || currentNotes !== metadataDraft.notes
  }, [currentTarget, metadataDraft])

  useEffect(() => {
    if (metadataChanged) {
      setMetadataFeedback('')
    }
  }, [metadataChanged])

  useEffect(() => {
    if (currentTarget) {
      setMetadataDraft({
        url: currentTarget.url ?? '',
        notes: currentTarget.notes ?? '',
      })
      setMetadataFeedback('')
    } else {
      setMetadataDraft({ url: '', notes: '' })
    }
    setExportError('')
  }, [currentTarget])

  const logout = useCallback(
    (message) => {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('pmd_token')
      }
      setToken(null)
      setView('dashboard')
      setSelectedId(null)
      setTargets([])
      setLogs([])
      setInsightsMap({})
      insightsMapRef.current = {}
      insightFreshnessRef.current = {}
      setTraceResult(null)
      setTraceError('')
      setIsExporting(false)
      setExportError('')
      setMetadataDraft({ url: '', notes: '' })
      setMetadataFeedback('')
      if (message) {
        setError(message)
      }
    },
    [],
  )

  const updateInsightsState = useCallback((targetId, data) => {
    setInsightsMap((prev) => {
      const next = { ...prev, [targetId]: data }
      insightsMapRef.current = next
      return next
    })
  }, [])

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

  const apiCall = useCallback(async (endpoint, options = {}) => {
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
          console.error(err)
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
  }, [logout, t, token])

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
      const freshnessWindow = force ? 0 : DETAIL_INSIGHTS_REFRESH_MS
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

  const refreshSelectedInsights = useCallback(
    async (force = false, customWindowMinutes, explicitTargetId, { showSpinner = true } = {}) => {
      const targetId = explicitTargetId ?? selectedId
      if (!targetId) return null
      const minutes = customWindowMinutes ?? insightWindow
      if (showSpinner) {
        setIsInsightsLoading(true)
      }
      try {
        return await updateInsights(
          targetId,
          {
            windowMinutes: minutes,
            bucketSeconds: bucketSecondsForWindow(minutes),
          },
          force,
        )
      } finally {
        if (showSpinner) {
          setIsInsightsLoading(false)
        }
      }
    },
    [insightWindow, selectedId, updateInsights],
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
        setLogs([])
      }
    } catch (err) {
      // handled in apiCall
    }
  }, [apiCall, refreshDashboardInsights, selectedId, token])

  const loadLogs = useCallback(async (id) => {
    if (!id || !token) return
    try {
      const result = await apiCall(`/targets/${id}/logs?limit=${LOG_LIMIT}`)
      setLogs(result)
    } catch (err) {
      // handled upstream
    }
  }, [apiCall, token])

  const handleRefresh = useCallback(async () => {
    if (!token) return
    if (view === 'details' && selectedId) {
      await loadLogs(selectedId)
      await refreshSelectedInsights(true)
    } else {
      await loadTargets()
    }
  }, [loadLogs, loadTargets, refreshSelectedInsights, selectedId, token, view])

  useEffect(() => {
    if (!token) return
    loadTargets()
  }, [loadTargets, token])

  useEffect(() => {
    if (!token) return
    if (view === 'details' && selectedId) {
      loadLogs(selectedId)
    }
  }, [view, selectedId, loadLogs, token])

  useEffect(() => {
    if (!token) return
    if (view === 'details' && selectedId) {
      refreshSelectedInsights(true)
    }
  }, [refreshSelectedInsights, selectedId, token, view])

  useEffect(() => {
    if (!token) return undefined
    const interval = setInterval(() => {
      if (view === 'details' && selectedId) {
        loadLogs(selectedId)
        refreshSelectedInsights(false, undefined, undefined, { showSpinner: false })
      } else if (view === 'dashboard') {
        loadTargets()
      }
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [loadLogs, loadTargets, refreshSelectedInsights, selectedId, token, view])

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

  const handleMetadataSave = useCallback(async () => {
    if (!currentTarget || !metadataChanged) return
    setIsSavingMetadata(true)
    setMetadataFeedback('')
    try {
      const payload = {
        url: metadataDraft.url.trim(),
        notes: metadataDraft.notes,
      }
      const updated = await apiCall(`/targets/${currentTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setTargets((prev) => prev.map((target) => (target.id === updated.id ? updated : target)))
      setMetadataDraft({ url: updated.url ?? '', notes: updated.notes ?? '' })
      setMetadataFeedback(t('details.notesSaved'))
    } catch (err) {
      setMetadataFeedback(err?.message ?? t('details.notesError'))
    } finally {
      setIsSavingMetadata(false)
    }
  }, [apiCall, currentTarget, metadataChanged, metadataDraft.notes, metadataDraft.url, t])

  const handleSelectTarget = (id) => {
    setSelectedId(id)
    setView('details')
    setTraceResult(null)
    setTraceError('')
    loadLogs(id)
    refreshSelectedInsights(true, undefined, id)
  }

  const toggleCurrentTarget = async () => {
    if (!currentTarget) return
    setIsBusy(true)
    try {
      const action = currentTarget.is_active ? 'pause' : 'resume'
      await apiCall(`/targets/${currentTarget.id}/${action}`, { method: 'POST' })
      await loadTargets()
      await loadLogs(currentTarget.id)
      await refreshSelectedInsights(true, undefined, currentTarget.id)
    } catch (err) {
      // handled upstream
    } finally {
      setIsBusy(false)
    }
  }

  const deleteCurrentTarget = async () => {
    if (!currentTarget) return
    const confirmDelete = window.confirm(t('details.deleteConfirm'))
    if (!confirmDelete) return
    setIsBusy(true)
    try {
      await apiCall(`/targets/${currentTarget.id}`, { method: 'DELETE' })
      await loadTargets()
      setView('dashboard')
      setSelectedId(null)
      setLogs([])
      setInsightsMap((prev) => {
        const next = { ...prev }
        delete next[currentTarget.id]
        insightsMapRef.current = next
        return next
      })
    } catch (err) {
      // handled upstream
    } finally {
      setIsBusy(false)
    }
  }

  const handleRunTraceroute = useCallback(async () => {
    if (!selectedId) return
    setIsTracing(true)
    setTraceError('')
    try {
      const result = await apiCall(`/targets/${selectedId}/traceroute`, { method: 'POST' })
      setTraceResult(result)
    } catch (err) {
      setTraceError(err.message ?? t('traceroute.unavailable'))
    } finally {
      setIsTracing(false)
    }
  }, [apiCall, selectedId, t])

  const handleExportLogs = useCallback(async () => {
    if (!currentTarget || !token) return
    setIsExporting(true)
    setExportError('')
    try {
      const response = await fetch(`${API_BASE_URL}/targets/${currentTarget.id}/logs/export`, {
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
          console.error(err)
        }
        throw new Error(detail ?? `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const day = new Date().toISOString().split('T')[0]
      link.href = downloadUrl
      link.download = `pingmedaddy-target-${currentTarget.id}-${day}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(downloadUrl)
    } catch (err) {
      setExportError(err?.message ?? t('details.exportError'))
    } finally {
      setIsExporting(false)
    }
  }, [currentTarget, logout, t, token])

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
          </section>
        )}

        {view === 'details' && currentTarget && (
          <section className="fade-in space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setView('dashboard')
                    setSelectedId(null)
                  }}
                  className="p-2 -ml-2 text-slate-400 hover:text-slate-800 transition-colors rounded-full hover:bg-slate-100"
                >
                  <ArrowLeft className="w-6 h-6" />
                </button>
                <div>
                  <h2 className="text-2xl font-bold text-slate-800">{currentTarget.ip}</h2>
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span className="font-mono">ID: {currentTarget.id}</span> &bull;
                    <span>
                      {t('details.freqLabel')} {currentTarget.frequency}s
                    </span>
                    <span className="hidden sm:inline">&bull;</span>
                    <span>
                      {t('details.startedAt')} {new Date(currentTarget.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
                <span
                  className={`ml-2 px-2.5 py-0.5 rounded text-xs font-semibold border uppercase tracking-wide ${currentTarget.is_active ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}
                >
                  {currentTarget.is_active ? t('details.badgeActive') : t('details.badgePaused')}
                </span>
              </div>
              <div className="flex gap-2">
                {currentTarget.url && (
                  <a
                    href={currentTarget.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md text-sm font-medium shadow-sm transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    {t('details.openInterface')}
                  </a>
                )}
                <button
                  type="button"
                  onClick={toggleCurrentTarget}
                  disabled={isBusy}
                  className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 rounded-md text-sm font-medium text-slate-700 transition-colors disabled:opacity-60"
                >
                  {currentTarget.is_active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  {currentTarget.is_active ? t('details.pause') : t('details.resume')}
                </button>
                <button
                  type="button"
                  onClick={deleteCurrentTarget}
                  disabled={isBusy}
                  className="flex items-center gap-2 px-3 py-2 bg-white border border-red-200 hover:bg-red-50 rounded-md text-sm font-medium text-red-600 transition-colors disabled:opacity-60"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
              <div className="flex items-start gap-3 mb-4">
                <NotebookPen className="w-5 h-5 text-slate-400 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-slate-700 text-sm">{t('details.notesTitle')}</h3>
                  <p className="text-xs text-slate-400">{t('details.notesHelper')}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-1">
                  <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">
                    {t('details.interfaceLabel')}
                  </label>
                  <input
                    type="url"
                    className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-100 focus:border-emerald-500"
                    placeholder={t('details.interfacePlaceholder')}
                    value={metadataDraft.url}
                    onChange={(event) => setMetadataDraft((prev) => ({ ...prev, url: event.target.value }))}
                  />
                </div>
                <div className="lg:col-span-2">
                  <label className="block text-xs font-semibold text-slate-500 uppercase mb-2">
                    {t('details.notesLabel')}
                  </label>
                  <textarea
                    className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm h-28 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-100 focus:border-emerald-500"
                    placeholder={t('details.notesPlaceholder')}
                    value={metadataDraft.notes}
                    onChange={(event) => setMetadataDraft((prev) => ({ ...prev, notes: event.target.value }))}
                  />
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4">
                <p className="text-xs text-slate-400 min-h-[1rem]">
                  {metadataFeedback || t('details.notesHelper')}
                </p>
                <button
                  type="button"
                  onClick={handleMetadataSave}
                  disabled={!metadataChanged || isSavingMetadata}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-60"
                >
                  {isSavingMetadata ? t('details.notesSaving') : t('details.notesSave')}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {insightCards.map((card) => (
                <StatsCard key={card.label} label={card.label} value={card.value} helper={card.helper} accent={card.accent} />
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm lg:col-span-2">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                  <div>
                    <h3 className="font-semibold text-slate-700 flex items-center gap-2">
                      <Activity className="w-4 h-4" /> {t('charts.latencyTitle')}
                    </h3>
                    <p className="text-xs text-slate-500">{t('charts.latencySubtitle', { window: windowLabel, samples: sampleSummary })}</p>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-100 rounded-full p-1">
                    {WINDOW_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => {
                          setInsightWindow(preset.value)
                          refreshSelectedInsights(true, preset.value)
                        }}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-full transition ${insightWindow === preset.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
                <LatencyTimelineChart data={timelineData} isLoading={isInsightsLoading} />
              </div>
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col h-[350px] lg:h-auto">
                <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-700 text-sm">{t('details.logsTitle')}</h3>
                    <p className="text-xs text-slate-400">{t('details.logsEntries', { count: logs.length })}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 bg-white px-2 py-1 rounded-full border border-slate-200">
                      {t('details.rawTag')}
                    </span>
                    <button
                      type="button"
                      onClick={handleExportLogs}
                      disabled={isExporting}
                      className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 bg-white border border-slate-300 px-3 py-1.5 rounded-full hover:bg-slate-100 transition disabled:opacity-60"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {isExporting ? t('details.exporting') : t('details.export')}
                    </button>
                  </div>
                </div>
                {exportError && (
                  <p className="px-5 pt-2 text-xs text-red-500">{exportError}</p>
                )}
                <LogsTable logs={reversedLogs} />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm lg:col-span-2">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-slate-700 text-sm">{t('details.lossTitle')}</h3>
                  <span className="text-xs text-slate-400">{t('details.lossSubtitle')}</span>
                </div>
                <LossTimelineChart data={timelineData} isLoading={isInsightsLoading} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 text-sm">
                  <div>
                    <p className="text-xs uppercase text-slate-400">{t('details.windowAnalyzed')}</p>
                    <p className="font-mono text-slate-700">{formatWindowRange(currentInsights)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-slate-400">{t('details.samplesLabel')}</p>
                    <p className="font-semibold text-slate-700">{sampleSummary}</p>
                  </div>
                </div>
              </div>
              <TraceroutePanel
                onRun={handleRunTraceroute}
                isLoading={isTracing}
                error={traceError}
                result={traceResult}
              />
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
