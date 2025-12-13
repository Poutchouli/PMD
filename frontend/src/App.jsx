import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Lock,
  LogOut,
  Globe,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  User,
  X,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:6666'
const POLL_INTERVAL = 3000
const LOG_LIMIT = 50
const LOG_VISIBLE_ROWS = 8
const LOG_ROW_HEIGHT_PX = 40
const LOGS_MAX_HEIGHT = `${LOG_VISIBLE_ROWS * LOG_ROW_HEIGHT_PX}px`
const DASHBOARD_INSIGHTS_REFRESH_MS = 60_000
const DETAIL_INSIGHTS_REFRESH_MS = 15_000
const WINDOW_PRESETS = [
  { label: '15 min', value: 15 },
  { label: '1 h', value: 60 },
  { label: '4 h', value: 240 },
  { label: '24 h', value: 1440 },
]

function App() {
  const [view, setView] = useState('dashboard')
  const [targets, setTargets] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [logs, setLogs] = useState([])
  const [form, setForm] = useState({ ip: '', frequency: 5 })
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
    if (!currentInsights) return 'En attente de mesures'
    return `${currentInsights.sample_count} échantillons`
  }, [currentInsights])
  const insightCards = useMemo(
    () => [
      {
        label: 'Uptime',
        value: formatPercent(currentInsights?.uptime_percent),
        helper: currentInsights ? `${currentInsights.loss_count} pertes` : sampleSummary,
        accent: currentInsights?.uptime_percent && currentInsights.uptime_percent < 95 ? 'text-amber-600' : 'text-emerald-600',
      },
      {
        label: 'Latence moyenne',
        value: formatLatency(currentInsights?.latency_avg_ms),
        helper: `p50 ${formatLatency(currentInsights?.latency_p50_ms)}`,
      },
      {
        label: 'Latence min',
        value: formatLatency(currentInsights?.latency_min_ms),
        helper: `max ${formatLatency(currentInsights?.latency_max_ms)}`,
      },
      {
        label: 'p95',
        value: formatLatency(currentInsights?.latency_p95_ms),
        helper: `p99 ${formatLatency(currentInsights?.latency_p99_ms)}`,
      },
      {
        label: 'Fenêtre',
        value: windowLabel,
        helper: sampleSummary,
      },
      {
        label: 'Dernier hop',
        value: typeof lastHop === 'number' ? lastHop : '--',
        helper: 'issus des logs bruts',
      },
    ],
    [currentInsights, lastHop, sampleSummary, windowLabel],
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
      setLogs([])
      setInsightsMap({})
      insightsMapRef.current = {}
      insightFreshnessRef.current = {}
      setTraceResult(null)
      setTraceError('')
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
        throw new Error(payload?.detail ?? 'Identifiants invalides')
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('pmd_token', payload.access_token)
      }
      setToken(payload.access_token)
      setLoginForm({ username: '', password: '' })
      setLoginError('')
      setError('')
    } catch (err) {
      setLoginError(err.message ?? 'Impossible de se connecter')
    } finally {
      setIsLoggingIn(false)
      setLoginForm((prev) => ({ ...prev, password: '' }))
    }
  }

  const apiCall = useCallback(async (endpoint, options = {}) => {
    if (!token) {
      throw new Error('Non authentifié')
    }
    try {
      const headers = new Headers(options.headers ?? {})
      headers.set('Authorization', `Bearer ${token}`)
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers,
      })
      if (response.status === 401) {
        logout('Session expirée, merci de vous reconnecter.')
        throw new Error('Session expirée')
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
      if (!String(err.message).includes('Session expirée')) {
        setError("L'API est inaccessible. Vérifiez Docker ou la configuration réseau.")
      }
      throw err
    }
  }, [logout, token])

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
      await apiCall('/targets/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: form.ip.trim(), frequency: Number(form.frequency) }),
      })
      setForm({ ip: '', frequency: 5 })
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
    const confirmDelete = window.confirm("Arrêter la surveillance et supprimer l'historique ?")
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
      setTraceError(err.message ?? 'Traceroute indisponible')
    } finally {
      setIsTracing(false)
    }
  }, [apiCall, selectedId])

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
                PingMeDaddy <span className="text-slate-400 font-normal text-sm">Analytics</span>
              </p>
            </div>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="p-2 text-slate-400 hover:text-slate-600 transition-colors rounded-full hover:bg-slate-100"
              title="Actualiser les données"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => logout()}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-full hover:bg-slate-50"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Déconnexion</span>
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
                <p className="font-bold">Erreur de connexion</p>
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
                <h2 className="text-2xl font-semibold text-slate-800">Cibles surveillées</h2>
                <p className="text-slate-500 text-sm mt-1">Sélectionnez une cible pour voir l'analyse détaillée.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setView('create')
                  setForm({ ip: '', frequency: 5 })
                }}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-white px-4 py-2.5 rounded-md shadow-sm transition-all text-sm font-medium"
              >
                <Plus className="w-4 h-4" /> Ajouter une cible
              </button>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider font-semibold border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-4 w-24">État</th>
                      <th className="px-6 py-4">Adresse IP / Hôte</th>
                      <th className="px-6 py-4">Fréquence</th>
                      <th className="px-6 py-4">Dernière activité</th>
                      <th className="px-6 py-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {targets.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-12 text-center">
                          <div className="flex flex-col items-center text-slate-500 gap-3">
                            <Server className="w-10 h-10 text-slate-300" />
                            <p>Ajoutez votre première IP pour commencer l'analyse.</p>
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
                              Actif
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200 uppercase tracking-wide">
                              Pause
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-bold text-slate-700 text-base">{target.ip}</div>
                          <p className="text-xs text-slate-500 mt-1">
                            {rowInsights
                              ? `${formatLatency(rowInsights.latency_avg_ms)} • Uptime ${formatPercent(rowInsights.uptime_percent)}`
                              : 'Calcul des stats…'}
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
              <span className="text-sm font-medium">Retour à la liste</span>
            </button>
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-8">
              <h2 className="text-xl font-semibold text-slate-800 mb-6">Nouvelle surveillance</h2>
              <form onSubmit={handleCreateSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Adresse IP ou Nom de domaine</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Globe className="w-4 h-4 text-slate-400" />
                    </div>
                    <input
                      type="text"
                      className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-md focus:ring-2 focus:ring-slate-200 focus:border-slate-400 outline-none transition-all"
                      placeholder="ex: 8.8.8.8"
                      value={form.ip}
                      onChange={(event) => setForm((prev) => ({ ...prev, ip: event.target.value }))}
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Fréquence de ping (secondes)</label>
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
                <div className="pt-4 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setView('dashboard')}
                    className="flex-1 px-4 py-2.5 border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 font-medium text-sm transition-colors"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1 px-4 py-2.5 bg-slate-800 text-white rounded-md hover:bg-slate-700 font-medium text-sm shadow-sm transition-all disabled:opacity-60"
                  >
                    {isSubmitting ? 'En cours…' : 'Démarrer'}
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
                    <span>Freq: {currentTarget.frequency}s</span>
                    <span className="hidden sm:inline">&bull;</span>
                    <span>Lancé le {new Date(currentTarget.created_at).toLocaleString()}</span>
                  </div>
                </div>
                <span
                  className={`ml-2 px-2.5 py-0.5 rounded text-xs font-semibold border uppercase tracking-wide ${currentTarget.is_active ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}
                >
                  {currentTarget.is_active ? 'SURVEILLANCE ACTIVE' : 'EN PAUSE'}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={toggleCurrentTarget}
                  disabled={isBusy}
                  className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 rounded-md text-sm font-medium text-slate-700 transition-colors disabled:opacity-60"
                >
                  {currentTarget.is_active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  {currentTarget.is_active ? 'Pause' : 'Reprendre'}
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
                      <Activity className="w-4 h-4" /> Analytique de latence
                    </h3>
                    <p className="text-xs text-slate-500">Fenêtre {windowLabel} • {sampleSummary}</p>
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
                <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-slate-700 text-sm">Derniers Échantillons</h3>
                    <p className="text-xs text-slate-400">{logs.length} entrées</p>
                  </div>
                  <span className="text-xs text-slate-400 bg-white px-2 py-1 rounded-full border border-slate-200">RAW</span>
                </div>
                <LogsTable logs={reversedLogs} />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm lg:col-span-2">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-slate-700 text-sm">Perte & disponibilité</h3>
                  <span className="text-xs text-slate-400">Mise à jour continue</span>
                </div>
                <LossTimelineChart data={timelineData} isLoading={isInsightsLoading} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 text-sm">
                  <div>
                    <p className="text-xs uppercase text-slate-400">Fenêtre analysée</p>
                    <p className="font-mono text-slate-700">{formatWindowRange(currentInsights)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-slate-400">Échantillons</p>
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

function StatsCard({ label, value, helper, accent }) {
  return (
    <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accent ?? 'text-slate-800'}`}>{value ?? '--'}</p>
      {helper && <p className="text-xs text-slate-500 mt-1">{helper}</p>}
    </div>
  )
}

function LogsTable({ logs }) {
  if (!logs.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        En attente de données…
      </div>
    )
  }

  return (
    <div className="overflow-y-auto flex-1" style={{ maxHeight: LOGS_MAX_HEIGHT }}>
      <table className="w-full text-left text-xs">
        <thead className="bg-white sticky top-0 z-10 text-slate-500 font-semibold border-b border-slate-100">
          <tr>
            <th className="px-4 py-2">Heure</th>
            <th className="px-4 py-2">Latence</th>
            <th className="px-4 py-2 text-right">État</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {logs.map((log) => {
            const time = new Date(log.time).toLocaleTimeString()
            if (log.packet_loss) {
              return (
                <tr key={log.time} className="bg-red-50/60">
                  <td className="px-4 py-2 font-mono text-red-400 text-xs">{time}</td>
                  <td className="px-4 py-2 text-red-400 italic text-xs">Timeout</td>
                  <td className="px-4 py-2 text-right">
                    <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                  </td>
                </tr>
              )
            }
            return (
              <tr key={log.time} className="hover:bg-slate-50">
                <td className="px-4 py-2 font-mono text-slate-500 text-xs">{time}</td>
                <td className="px-4 py-2 font-medium text-slate-700">
                  {typeof log.latency_ms === 'number' ? `${log.latency_ms.toFixed(1)} ms` : '--'}
                </td>
                <td className="px-4 py-2 text-right">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LatencyTimelineChart({ data, isLoading }) {
  if (isLoading) {
    return <ChartPlaceholder message="Calcul des insights…" heightClass="h-72" />
  }
  if (!data.length) {
    return <ChartPlaceholder message="En attente de mesures agrégées" heightClass="h-72" />
  }
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" />
          <XAxis dataKey="label" minTickGap={24} />
          <YAxis unit=" ms" width={60} />
          <RechartsTooltip content={<TimelineTooltip />} />
          <Area
            type="monotone"
            dataKey="avg"
            name="Moyenne"
            stroke="#0f172a"
            fill="#0f172a1a"
            strokeWidth={2}
            activeDot={{ r: 4 }}
          />
          <Line type="monotone" dataKey="min" name="Min" stroke="#10b981" dot={false} strokeWidth={1.5} />
          <Line type="monotone" dataKey="max" name="Max" stroke="#ef4444" dot={false} strokeWidth={1.2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function LossTimelineChart({ data, isLoading }) {
  if (isLoading) {
    return <ChartPlaceholder message="Mise à jour…" heightClass="h-56" />
  }
  if (!data.length) {
    return <ChartPlaceholder message="Aucune perte mesurée" heightClass="h-56" />
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis dataKey="label" minTickGap={24} />
          <YAxis unit=" %" width={50} domain={[0, 'auto']} />
          <RechartsTooltip
            formatter={(value) => [
              `${typeof value === 'number' ? value.toFixed(1) : value} %`,
              'Perte',
            ]}
            labelFormatter={(label, payload) => payload?.[0]?.payload.fullLabel ?? label}
          />
          <Bar dataKey="lossRatePct" name="Perte (%)" fill="#fb923c" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function TimelineTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null
  const point = payload[0].payload
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm text-xs space-y-1">
      <p className="font-semibold text-slate-700">{point.fullLabel}</p>
      <p className="text-slate-500">{point.samples} échantillons</p>
      <div className="pt-1 space-y-1">
        <div className="flex justify-between">
          <span>Moyenne</span>
          <span className="font-semibold">{formatLatency(point.avg)}</span>
        </div>
        <div className="flex justify-between">
          <span>Min</span>
          <span>{formatLatency(point.min)}</span>
        </div>
        <div className="flex justify-between">
          <span>Max</span>
          <span>{formatLatency(point.max)}</span>
        </div>
        <div className="flex justify-between">
          <span>Perte</span>
          <span>{formatPercent(point.lossRatePct)}</span>
        </div>
      </div>
    </div>
  )
}

function TraceroutePanel({ onRun, isLoading, error, result }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col">
      <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-700 text-sm">Traceroute à la demande</h3>
          <p className="text-xs text-slate-500">Exécutez un traceroute depuis le backend</p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={isLoading}
          className="px-3 py-1.5 text-xs font-semibold rounded-md bg-slate-900 text-white hover:bg-slate-700 transition disabled:opacity-60"
        >
          {isLoading ? 'En cours…' : 'Lancer'}
        </button>
      </div>
      <div className="p-5 space-y-4 flex-1 flex flex-col">
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded-md">{error}</div>
        )}
        {result ? (
          <>
            <p className="text-xs text-slate-500">
              Dernier run {formatDateTime(result.finished_at)} • {result.hops.length} hops • {Math.round(result.duration_ms)} ms
            </p>
            <div className="overflow-x-auto border border-slate-100 rounded-md flex-1">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Hop</th>
                    <th className="px-3 py-2 text-left">Noeud</th>
                    <th className="px-3 py-2 text-left">IP</th>
                    <th className="px-3 py-2 text-right">Latence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.hops.map((hop) => (
                    <tr key={hop.hop} className={hop.is_timeout ? 'bg-amber-50' : 'bg-white'}>
                      <td className="px-3 py-1.5 font-mono text-slate-500">{hop.hop}</td>
                      <td className="px-3 py-1.5 text-slate-700">{hop.host ?? 'timeout'}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-500">{hop.ip ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right text-slate-700">
                        {hop.is_timeout ? '—' : formatLatency(hop.rtt_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-400 font-mono">{result.ip}</p>
          </>
        ) : (
          <div className="text-sm text-slate-500 flex-1 flex items-center">
            Lancez un traceroute pour visualiser le chemin réseau.
          </div>
        )}
      </div>
    </div>
  )
}

function ChartPlaceholder({ message, heightClass }) {
  return (
    <div className={`${heightClass} bg-slate-50 border border-dashed border-slate-200 rounded-lg flex items-center justify-center`}>
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  )
}

function formatLatency(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--'
  return `${value.toFixed(1)} ms`
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--'
  return `${value.toFixed(1)} %`
}

function formatWindowLabel(minutes) {
  if (minutes >= 60) {
    const hours = minutes / 60
    return `${hours % 1 === 0 ? hours : hours.toFixed(1)} h`
  }
  return `${minutes} min`
}

function formatWindowRange(insights) {
  if (!insights?.window_start || !insights?.window_end) return '--'
  return `${formatDateTime(insights.window_start)} -> ${formatDateTime(insights.window_end)}`
}

function formatDateTime(value) {
  if (!value) return '--'
  return new Date(value).toLocaleString()
}

function buildTimelineData(insights) {
  if (!insights?.timeline?.length) return []
  return insights.timeline.map((point) => {
    const date = new Date(point.bucket)
    const label = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const lossRatePct = Number(((point.loss_rate ?? 0) * 100).toFixed(2))
    return {
      label,
      fullLabel: date.toLocaleString(),
      avg: point.avg_latency_ms ?? null,
      min: point.min_latency_ms ?? null,
      max: point.max_latency_ms ?? null,
      lossRatePct,
      samples: point.sample_count,
    }
  })
}

function bucketSecondsForWindow(windowMinutes) {
  if (windowMinutes <= 15) return 30
  if (windowMinutes <= 60) return 60
  if (windowMinutes <= 240) return 120
  if (windowMinutes <= 720) return 300
  return 900
}

function LoginScreen({ form, onChange, onSubmit, error, isLoading }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white/10 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-slate-900 text-white p-2 rounded-xl">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <p className="text-lg font-semibold text-white">PingMeDaddy</p>
            <p className="text-sm text-slate-300">Déverrouillez le tableau de bord</p>
          </div>
        </div>
        {error && (
          <div className="mb-4 text-sm text-red-300 bg-red-500/10 border border-red-400 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <form className="space-y-5" onSubmit={onSubmit}>
          <div>
            <label className="text-sm font-medium text-slate-200">Identifiant</label>
            <div className="relative mt-1">
              <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg pl-10 pr-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent placeholder:text-slate-500"
                placeholder="admin"
                value={form.username}
                onChange={(event) => onChange((prev) => ({ ...prev, username: event.target.value }))}
                autoComplete="username"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-slate-200">Mot de passe</label>
            <div className="relative mt-1">
              <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg pl-10 pr-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent placeholder:text-slate-500"
                placeholder="••••••••"
                value={form.password}
                onChange={(event) => onChange((prev) => ({ ...prev, password: event.target.value }))}
                autoComplete="current-password"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={isLoading || !form.username || !form.password}
            className="w-full flex items-center justify-center gap-2 bg-slate-100 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-white transition disabled:opacity-60"
          >
            {isLoading ? 'Connexion…' : 'Déverrouiller'}
          </button>
          <p className="text-xs text-slate-400 text-center">
            Identifiants configurables via les variables d'environnement `ADMIN_USERNAME` et `ADMIN_PASSWORD`.
          </p>
        </form>
      </div>
    </div>
  )
}

export default App
