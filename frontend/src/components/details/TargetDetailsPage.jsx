import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  ArrowLeft,
  Download,
  ExternalLink,
  NotebookPen,
  Pause,
  Play,
  Trash2,
} from 'lucide-react'
import StatsCard from '../analytics/StatsCard'
import LatencyTimelineChart from '../analytics/LatencyTimelineChart'
import LossTimelineChart from '../analytics/LossTimelineChart'
import LogsTable from '../logs/LogsTable'
import EventLog from '../logs/EventLog'
import TraceroutePanel from '../network/TraceroutePanel'
import { useTranslation } from '../../i18n/LanguageProvider'
import { formatLatency, formatPercent, formatWindowLabel, formatWindowRange } from '../../utils/formatters'
import { buildTimelineData, bucketSecondsForWindow } from '../../utils/insights'

const LOG_LIMIT = 50
const POLL_INTERVAL = 3000
const DETAIL_INSIGHTS_REFRESH_MS = 15_000

const WINDOW_PRESETS = [
  { label: '15 min', value: 15 },
  { label: '1 h', value: 60 },
  { label: '4 h', value: 240 },
  { label: '24 h', value: 1440 },
]

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:6666'

function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof document === 'undefined') return true
    return !document.hidden
  })

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const handleVisibilityChange = () => setIsVisible(!document.hidden)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  return isVisible
}

function TargetDetailsPage({
  target,
  token,
  apiCall,
  onBack,
  onTargetUpdate,
  onTargetDelete,
  onToggleTarget,
  refreshSignal,
  isBusy,
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const isVisible = usePageVisibility()
  const [insightWindow, setInsightWindow] = useState(60)
  const [customRange, setCustomRange] = useState(null)
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [metadataDraft, setMetadataDraft] = useState({ url: '', notes: '' })
  const [metadataFeedback, setMetadataFeedback] = useState('')
  const [isSavingMetadata, setIsSavingMetadata] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [traceError, setTraceError] = useState('')
  const [isTracing, setIsTracing] = useState(false)
  const [traceResult, setTraceResult] = useState(null)

  useEffect(() => {
    setInsightWindow(60)
    setCustomRange(null)
    setRangeStart('')
    setRangeEnd('')
    setRangeError('')
    setTraceResult(null)
    setTraceError('')
    setMetadataFeedback('')
    setMetadataDraft({ url: target?.url ?? '', notes: target?.notes ?? '' })
    queryClient.removeQueries({ queryKey: ['logs', target?.id] })
    queryClient.removeQueries({ queryKey: ['insights', target?.id] })
    queryClient.removeQueries({ queryKey: ['events', target?.id] })
  }, [queryClient, target])

  const metadataChanged = useMemo(() => {
    if (!target) return false
    const currentUrl = target.url ?? ''
    const currentNotes = target.notes ?? ''
    return currentUrl !== metadataDraft.url || currentNotes !== metadataDraft.notes
  }, [metadataDraft.notes, metadataDraft.url, target])

  const insightKey = useMemo(() => {
    if (customRange) {
      return `${customRange.start}-${customRange.end}`
    }
    return `window-${insightWindow}`
  }, [customRange, insightWindow])

  const logsQuery = useQuery({
    queryKey: ['logs', target?.id],
    queryFn: async () => apiCall(`/targets/${target.id}/logs?limit=${LOG_LIMIT}`),
    enabled: Boolean(target?.id),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: () => {
      if (!target?.is_active) return false
      if (!isVisible) return false
      return POLL_INTERVAL
    },
    refetchIntervalInBackground: false,
  })

  // Check if last 5 pings have issues (packet loss) - only refresh events when there are problems
  const hasRecentIssues = useMemo(() => {
    const recentLogs = logsQuery.data?.slice(0, 5) ?? []
    if (recentLogs.length === 0) return false
    return recentLogs.some((log) => log.packet_loss)
  }, [logsQuery.data])

  const insightsQuery = useQuery({
    queryKey: ['insights', target?.id, insightKey],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (customRange) {
        params.set('start', customRange.start)
        params.set('end', customRange.end)
        params.set('bucket_seconds', String(bucketSecondsForWindow(insightWindow)))
      } else {
        params.set('window_minutes', String(insightWindow))
        params.set('bucket_seconds', String(bucketSecondsForWindow(insightWindow)))
      }
      return apiCall(`/targets/${target.id}/insights?${params.toString()}`)
    },
    enabled: Boolean(target?.id),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: () => {
      if (!target?.is_active) return false
      if (!isVisible) return false
      if (customRange) return false
      return DETAIL_INSIGHTS_REFRESH_MS
    },
    refetchIntervalInBackground: false,
  })

  // Stabilize the window boundaries to prevent unnecessary refetches
  // Only update when window preset or custom range changes, not on every insights refresh
  const stableEventWindow = useMemo(() => {
    if (!insightsQuery.data?.window_start || !insightsQuery.data?.window_end) return null
    return {
      start: insightsQuery.data.window_start,
      end: insightsQuery.data.window_end,
    }
  }, [insightKey, Boolean(insightsQuery.data)]) // eslint-disable-line react-hooks/exhaustive-deps

  const eventsQuery = useQuery({
    queryKey: ['events', target?.id, insightKey],
    queryFn: async () => {
      const params = new URLSearchParams()
      params.set('start', stableEventWindow.start)
      params.set('end', stableEventWindow.end)
      return apiCall(`/targets/${target.id}/events?${params.toString()}`)
    },
    enabled: Boolean(target?.id && stableEventWindow),
    staleTime: 60_000, // Events don't change often, cache for 1 minute
    refetchOnWindowFocus: false, // Don't refetch on every focus
    // Only poll for events when there are recent issues (last 5 pings have problems)
    refetchInterval: () => {
      if (!target?.is_active) return false
      if (!isVisible) return false
      if (!hasRecentIssues) return false // Only refetch if there are recent issues
      return 30_000 // Check every 30s when there are issues
    },
    refetchIntervalInBackground: false,
  })

  useEffect(() => {
    if (!refreshSignal) return
    logsQuery.refetch()
    insightsQuery.refetch()
    eventsQuery.refetch()
  }, [eventsQuery, insightsQuery, logsQuery, refreshSignal])

  const reversedLogs = useMemo(() => {
    const data = logsQuery.data ?? []
    return [...data].reverse()
  }, [logsQuery.data])

  const insightsLoading = insightsQuery.isLoading || (insightsQuery.isFetching && !insightsQuery.data)
  const eventsLoading = eventsQuery.isLoading || (eventsQuery.isFetching && !eventsQuery.data)

  const lastHop = useMemo(() => {
    const latest = reversedLogs.find((log) => !log.packet_loss && typeof log.hops === 'number')
    return typeof latest?.hops === 'number' ? latest.hops : null
  }, [reversedLogs])

  const windowLabel = useMemo(() => {
    if (customRange && insightsQuery.data) {
      return formatWindowRange(insightsQuery.data)
    }
    return formatWindowLabel(insightWindow)
  }, [customRange, insightWindow, insightsQuery.data])

  const sampleSummary = useMemo(() => {
    if (!insightsQuery.data) return t('insights.waiting')
    return t('insights.sampleCount', { count: insightsQuery.data.sample_count ?? 0 })
  }, [insightsQuery.data, t])

  const insightCards = useMemo(
    () => [
      {
        label: t('insights.cards.uptime'),
        value: formatPercent(insightsQuery.data?.uptime_percent),
        helper: insightsQuery.data
          ? t('insights.lossCount', { count: insightsQuery.data.loss_count ?? 0 })
          : sampleSummary,
        accent:
          insightsQuery.data?.uptime_percent && insightsQuery.data.uptime_percent < 95
            ? 'text-amber-600'
            : 'text-emerald-600',
      },
      {
        label: t('insights.cards.latencyAvg'),
        value: formatLatency(insightsQuery.data?.latency_avg_ms),
        helper: t('insights.helpers.p50', { value: formatLatency(insightsQuery.data?.latency_p50_ms) }),
      },
      {
        label: t('insights.cards.latencyMin'),
        value: formatLatency(insightsQuery.data?.latency_min_ms),
        helper: t('insights.helpers.max', { value: formatLatency(insightsQuery.data?.latency_max_ms) }),
      },
      {
        label: t('insights.cards.latencyP95'),
        value: formatLatency(insightsQuery.data?.latency_p95_ms),
        helper: t('insights.helpers.p99', { value: formatLatency(insightsQuery.data?.latency_p99_ms) }),
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
    [insightsQuery.data, lastHop, sampleSummary, t, windowLabel],
  )

  const timelineData = useMemo(() => buildTimelineData(insightsQuery.data), [insightsQuery.data])

  const saveMetadata = useCallback(async () => {
    if (!target || !metadataChanged) return
    setIsSavingMetadata(true)
    setMetadataFeedback('')
    try {
      const payload = {
        url: metadataDraft.url.trim(),
        notes: metadataDraft.notes,
      }
      const updated = await apiCall(`/targets/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      onTargetUpdate(updated)
      setMetadataDraft({ url: updated.url ?? '', notes: updated.notes ?? '' })
      setMetadataFeedback(t('details.notesSaved'))
    } catch (err) {
      setMetadataFeedback(err?.message ?? t('details.notesError'))
    } finally {
      setIsSavingMetadata(false)
    }
  }, [apiCall, metadataChanged, metadataDraft.notes, metadataDraft.url, onTargetUpdate, t, target])

  const tracerouteMutation = useMutation({
    mutationFn: async () => apiCall(`/targets/${target.id}/traceroute`, { method: 'POST' }),
    onMutate: () => {
      setIsTracing(true)
      setTraceError('')
    },
    onSuccess: (result) => {
      setTraceResult(result)
    },
    onError: (err) => {
      setTraceError(err?.message ?? t('traceroute.unavailable'))
    },
    onSettled: () => setIsTracing(false),
  })

  const handleExportLogs = useCallback(async () => {
    if (!target || !token) return
    setIsExporting(true)
    setExportError('')
    try {
      const response = await fetch(`${API_BASE_URL}/targets/${target.id}/logs/export`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
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
      const day = new Date().toISOString().split('T')[0]
      link.href = downloadUrl
      link.download = `pingmedaddy-target-${target.id}-${day}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(downloadUrl)
    } catch (err) {
      setExportError(err?.message ?? t('details.exportError'))
    } finally {
      setIsExporting(false)
    }
  }, [t, target, token])

  const applyCustomRange = useCallback(async () => {
    if (!rangeStart || !rangeEnd) {
      setRangeError(t('history.rangeMissing'))
      return
    }

    const startDate = new Date(rangeStart)
    const endDate = new Date(rangeEnd)
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate >= endDate) {
      setRangeError(t('history.rangeInvalid'))
      return
    }

    setRangeError('')
    const payload = {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    }
    const minutes = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 60000))
    setCustomRange(payload)
    setInsightWindow(minutes)
    await insightsQuery.refetch()
  }, [insightsQuery, rangeEnd, rangeStart, t])

  const clearCustomRange = useCallback(async () => {
    setCustomRange(null)
    setRangeStart('')
    setRangeEnd('')
    setRangeError('')
    setInsightWindow(60)
    await insightsQuery.refetch()
  }, [insightsQuery])

  const isLoadingAnything = isBusy || insightsQuery.isLoading || logsQuery.isLoading

  return (
    <section className="fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="p-2 -ml-2 text-slate-400 hover:text-slate-800 transition-colors rounded-full hover:bg-slate-100"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div>
            <h2 className="text-2xl font-bold text-slate-800">{target.ip}</h2>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="font-mono">ID: {target.id}</span> &bull;
              <span>
                {t('details.freqLabel')} {target.frequency}s
              </span>
              <span className="hidden sm:inline">&bull;</span>
              <span>
                {t('details.startedAt')} {new Date(target.created_at).toLocaleString()}
              </span>
            </div>
          </div>
          <span
            className={`ml-2 px-2.5 py-0.5 rounded text-xs font-semibold border uppercase tracking-wide ${target.is_active ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}
          >
            {target.is_active ? t('details.badgeActive') : t('details.badgePaused')}
          </span>
        </div>
        <div className="flex gap-2">
          {target.url && (
            <a
              href={target.url}
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
            onClick={() => onToggleTarget(target)}
            disabled={isLoadingAnything}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 rounded-md text-sm font-medium text-slate-700 transition-colors disabled:opacity-60"
          >
            {target.is_active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {target.is_active ? t('details.pause') : t('details.resume')}
          </button>
          <button
            type="button"
            onClick={() => onTargetDelete(target)}
            disabled={isLoadingAnything}
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
              onChange={(event) => {
                setMetadataDraft((prev) => ({ ...prev, url: event.target.value }))
                setMetadataFeedback('')
              }}
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
              onChange={(event) => {
                setMetadataDraft((prev) => ({ ...prev, notes: event.target.value }))
                setMetadataFeedback('')
              }}
            />
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4">
          <p className="text-xs text-slate-400 min-h-[1rem]">{metadataFeedback || t('details.notesHelper')}</p>
          <button
            type="button"
            onClick={saveMetadata}
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
              <p className="text-xs text-slate-500">
                {t('charts.latencySubtitle', { window: windowLabel, samples: sampleSummary })}
              </p>
            </div>
            <div className="flex items-center gap-2 bg-slate-100 rounded-full p-1">
              {WINDOW_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => {
                    setCustomRange(null)
                    setRangeError('')
                    setRangeStart('')
                    setRangeEnd('')
                    setInsightWindow(preset.value)
                    insightsQuery.refetch()
                  }}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-full transition ${insightWindow === preset.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 mb-4">
            <div className="flex flex-col lg:flex-row lg:items-center gap-2">
              <div className="flex flex-1 gap-2">
                <input
                  type="datetime-local"
                  value={rangeStart}
                  onChange={(event) => {
                    setRangeStart(event.target.value)
                    setRangeError('')
                  }}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-100 focus:border-emerald-500"
                  aria-label={t('history.rangeStart')}
                />
                <input
                  type="datetime-local"
                  value={rangeEnd}
                  onChange={(event) => {
                    setRangeEnd(event.target.value)
                    setRangeError('')
                  }}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-100 focus:border-emerald-500"
                  aria-label={t('history.rangeEnd')}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={applyCustomRange}
                  className="px-3 py-2 rounded-md text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition disabled:opacity-60"
                  disabled={insightsQuery.isFetching}
                >
                  {t('history.applyRange')}
                </button>
                {customRange && (
                  <button
                    type="button"
                    onClick={clearCustomRange}
                    className="px-3 py-2 rounded-md text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 transition"
                  >
                    {t('history.resetRange')}
                  </button>
                )}
              </div>
            </div>
            {rangeError && <p className="text-xs text-red-500">{rangeError}</p>}
            {!rangeError && customRange && (
              <p className="text-xs text-emerald-700">{t('history.rangeActive', { range: windowLabel })}</p>
            )}
          </div>
          <LatencyTimelineChart data={timelineData} isLoading={insightsLoading} />
        </div>
        <div className="flex flex-col gap-4">
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col h-[350px] lg:h-auto">
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-700 text-sm">{t('details.logsTitle')}</h3>
                <p className="text-xs text-slate-400">{t('details.logsEntries', { count: logsQuery.data?.length ?? 0 })}</p>
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
            {exportError && <p className="px-5 pt-2 text-xs text-red-500">{exportError}</p>}
            <LogsTable logs={reversedLogs} />
          </div>

          <EventLog
            events={eventsQuery.data ?? []}
            isLoading={eventsLoading}
            error={eventsQuery.isError ? t('history.eventsError') : eventsQuery.error?.message ?? ''}
            rangeLabel={insightsQuery.data ? formatWindowRange(insightsQuery.data) : ''}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-700 text-sm">{t('details.lossTitle')}</h3>
            <span className="text-xs text-slate-400">{t('details.lossSubtitle')}</span>
          </div>
          <LossTimelineChart data={timelineData} isLoading={insightsLoading} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 text-sm">
            <div>
              <p className="text-xs uppercase text-slate-400">{t('details.windowAnalyzed')}</p>
              <p className="font-mono text-slate-700">{formatWindowRange(insightsQuery.data)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400">{t('details.samplesLabel')}</p>
              <p className="font-semibold text-slate-700">{sampleSummary}</p>
            </div>
          </div>
        </div>
        <TraceroutePanel
          onRun={() => tracerouteMutation.mutate()}
          isLoading={isTracing}
          error={traceError}
          result={traceResult}
        />
      </div>
    </section>
  )
}

export default TargetDetailsPage
