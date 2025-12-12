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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:6666'
const POLL_INTERVAL = 3000
const LOG_LIMIT = 50

const initialStats = {
  avg: '-- ms',
  max: '-- ms',
  loss: '-- %',
  hops: '--',
  lossTone: 'text-slate-500',
}

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
      setLogs([])
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

  const stats = useMemo(() => {
    if (!logs.length) return initialStats

    const total = logs.length
    const losses = logs.filter((log) => log.packet_loss).length
    const valid = logs.filter((log) => !log.packet_loss && typeof log.latency_ms === 'number')
    const avg = valid.length
      ? (valid.reduce((sum, log) => sum + log.latency_ms, 0) / valid.length).toFixed(1)
      : null
    const max = valid.length ? Math.max(...valid.map((log) => log.latency_ms)).toFixed(1) : null
    const hops = valid.length ? valid[valid.length - 1].hops ?? '--' : '--'
    const lossRate = ((losses / total) * 100).toFixed(1)

    return {
      avg: avg ? `${avg} ms` : '--',
      max: max ? `${max} ms` : '--',
      loss: `${lossRate} %`,
      hops,
      lossTone: parseFloat(lossRate) > 0 ? 'text-red-600' : 'text-emerald-600',
    }
  }, [logs])

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

  const loadTargets = useCallback(async () => {
    if (!token) return
    try {
      const result = await apiCall('/targets/')
      result.sort((a, b) => a.id - b.id)
      setTargets(result)
      if (selectedId && !result.some((target) => target.id === selectedId)) {
        setSelectedId(null)
        setView('dashboard')
        setLogs([])
      }
    } catch (err) {
      // handled in apiCall
    }
  }, [apiCall, selectedId, token])

  const loadAnalysis = useCallback(async (id) => {
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
      await loadAnalysis(selectedId)
    } else {
      await loadTargets()
    }
  }, [loadAnalysis, loadTargets, selectedId, token, view])

  useEffect(() => {
    if (!token) return
    loadTargets()
  }, [loadTargets, token])

  useEffect(() => {
    if (!token) return
    if (view === 'details' && selectedId) {
      loadAnalysis(selectedId)
    }
  }, [view, selectedId, loadAnalysis, token])

  useEffect(() => {
    if (!token) return undefined
    const interval = setInterval(() => {
      if (view === 'details' && selectedId) {
        loadAnalysis(selectedId)
      } else if (view === 'dashboard') {
        loadTargets()
      }
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [token, view, selectedId, loadAnalysis, loadTargets])

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
    loadAnalysis(id)
  }

  const toggleCurrentTarget = async () => {
    if (!currentTarget) return
    setIsBusy(true)
    try {
      const action = currentTarget.is_active ? 'pause' : 'resume'
      await apiCall(`/targets/${currentTarget.id}/${action}`, { method: 'POST' })
      await loadTargets()
      await loadAnalysis(currentTarget.id)
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
    } catch (err) {
      // handled upstream
    } finally {
      setIsBusy(false)
    }
  }

  const reversedLogs = useMemo(() => [...logs].reverse(), [logs])

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
                    {targets.map((target) => (
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
                        </td>
                        <td className="px-6 py-4 text-slate-500 font-mono text-xs">{target.frequency}s</td>
                        <td className="px-6 py-4 text-slate-400 text-xs">
                          {new Date(target.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <ChevronRight className="w-5 h-5 text-slate-300 inline-block" />
                        </td>
                      </tr>
                    ))}
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

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <StatsCard label="Latence Moyenne" value={stats.avg} />
              <StatsCard label="Latence Max" value={stats.max} />
              <StatsCard label="Taux de Perte" value={stats.loss} accent={stats.lossTone} />
              <StatsCard label="Sauts (Hops)" value={stats.hops ?? '--'} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm lg:col-span-2">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-semibold text-slate-700 flex items-center gap-2">
                    <Activity className="w-4 h-4" /> Courbe de Latence
                  </h3>
                  <span className="text-xs text-slate-400 bg-slate-50 px-2 py-1 rounded">50 derniers points</span>
                </div>
                <div className="chart-container bg-slate-50 rounded border border-slate-100 overflow-hidden">
                  <LatencyChart logs={logs} />
                </div>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col h-[350px] lg:h-auto">
                <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
                  <h3 className="font-semibold text-slate-700 text-sm">Derniers Échantillons</h3>
                </div>
                <LogsTable logs={reversedLogs} />
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function StatsCard({ label, value, accent }) {
  return (
    <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accent ?? 'text-slate-800'}`}>{value}</p>
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
    <div className="overflow-y-auto flex-1">
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

function LatencyChart({ logs }) {
  const canvasRef = useRef(null)

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const width = parent.clientWidth
    const height = parent.clientHeight
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    if (!logs.length) return

    const padding = { top: 20, right: 10, bottom: 24, left: 48 }
    const plotWidth = width - padding.left - padding.right
    const plotHeight = height - padding.top - padding.bottom
    const valid = logs.filter((log) => !log.packet_loss && typeof log.latency_ms === 'number')
    const maxLatency = valid.length ? Math.max(...valid.map((log) => log.latency_ms)) : 10
    const yScale = Math.max(maxLatency * 1.2, 10)
    const segments = Math.max(logs.length - 1, 1)
    const getX = (index) => padding.left + (index / segments) * plotWidth
    const getY = (latency) => padding.top + plotHeight - (latency / yScale) * plotHeight

    // Grid
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + (plotHeight * i) / 5
      ctx.moveTo(padding.left, y)
      ctx.lineTo(padding.left + plotWidth, y)
      ctx.fillStyle = '#94a3b8'
      ctx.font = '10px "Space Grotesk", sans-serif'
      ctx.textAlign = 'right'
      const label = Math.round(yScale - (yScale * i) / 5)
      ctx.fillText(`${label}ms`, padding.left - 6, y + 3)
    }
    ctx.stroke()

    // Curve
    ctx.strokeStyle = '#0f172a'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let drawing = false
    logs.forEach((log, index) => {
      if (log.packet_loss || typeof log.latency_ms !== 'number') {
        drawing = false
        return
      }
      const x = getX(index)
      const y = getY(log.latency_ms)
      if (!drawing) {
        ctx.moveTo(x, y)
        drawing = true
      } else {
        ctx.lineTo(x, y)
      }
    })
    ctx.stroke()

    // Points & losses
    logs.forEach((log, index) => {
      const x = getX(index)
      if (log.packet_loss) {
        ctx.beginPath()
        ctx.strokeStyle = '#ef4444'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.moveTo(x, padding.top)
        ctx.lineTo(x, padding.top + plotHeight)
        ctx.stroke()
        ctx.setLineDash([])
        return
      }
      if (logs.length < 80 && typeof log.latency_ms === 'number') {
        const y = getY(log.latency_ms)
        ctx.beginPath()
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 2
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    })
  }, [logs])

  useEffect(() => {
    drawChart()
  }, [drawChart])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => drawChart())
    observer.observe(canvas.parentElement)
    return () => observer.disconnect()
  }, [drawChart])

  return <canvas ref={canvasRef} className="w-full h-full" />
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
