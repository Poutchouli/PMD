import { ExternalLink } from 'lucide-react'
import { formatLatency, formatPercent, formatLossRate } from '../../utils/formatters'
import { computeHealthStatus } from '../../utils/insights'

const HEALTH_COLORS = {
  healthy:  { dot: 'bg-emerald-500', border: 'border-l-emerald-500', bg: 'hover:bg-emerald-50/40' },
  warning:  { dot: 'bg-amber-400',   border: 'border-l-amber-400',   bg: 'hover:bg-amber-50/40' },
  critical: { dot: 'bg-red-500',     border: 'border-l-red-500',     bg: 'hover:bg-red-50/40' },
  unknown:  { dot: 'bg-slate-300',   border: 'border-l-slate-300',   bg: 'hover:bg-slate-50' },
  paused:   { dot: 'bg-slate-300',   border: 'border-l-slate-200',   bg: 'hover:bg-slate-50' },
}

function MetricCell({ label, value, accent }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wider truncate">{label}</p>
      <p className={`text-sm font-semibold mt-0.5 truncate ${accent ?? 'text-slate-700'}`}>{value}</p>
    </div>
  )
}

function TargetCard({ target, insights, onSelect, onPrefetch, t }) {
  const health = computeHealthStatus(insights, target.is_active)
  const colors = HEALTH_COLORS[health]

  const lossRate = insights?.sample_count > 0
    ? (insights.loss_count / insights.sample_count) * 100
    : null

  const jitter = (typeof insights?.latency_max_ms === 'number' && typeof insights?.latency_min_ms === 'number')
    ? insights.latency_max_ms - insights.latency_min_ms
    : null

  const tooltipLines = [
    `${t('dashboard.tooltip.frequency')}: ${target.frequency}s`,
    `${t('dashboard.tooltip.createdAt')}: ${new Date(target.created_at).toLocaleDateString()}`,
  ]

  return (
    <div
      role="button"
      tabIndex={0}
      className={`bg-white rounded-lg shadow-sm border border-slate-200 border-l-4 ${colors.border} ${colors.bg} cursor-pointer transition-all p-4 flex flex-col gap-3`}
      onClick={() => onSelect(target.id)}
      onMouseEnter={() => onPrefetch(target.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(target.id) }}
      title={tooltipLines.join('\n')}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors.dot}`} />
          <span className="font-bold text-slate-800 text-base truncate">{target.ip}</span>
          {target.group_name && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold text-white truncate max-w-[6rem]"
              style={{ backgroundColor: target.group_color || '#64748b' }}
              title={target.group_name}
            >
              {target.group_name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {target.url && (
            <a
              href={target.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-600 hover:text-emerald-700 text-xs font-medium inline-flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
              title={t('dashboard.openInterface')}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          {target.is_active ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100 uppercase tracking-wide">
              {t('dashboard.statusActive')}
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200 uppercase tracking-wide">
              {t('dashboard.statusPaused')}
            </span>
          )}
        </div>
      </div>

      {/* Metrics grid */}
      {insights ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-2">
          <MetricCell
            label={t('dashboard.metrics.latencyAvg')}
            value={formatLatency(insights.latency_avg_ms)}
          />
          <MetricCell
            label={t('dashboard.metrics.latencyP95')}
            value={formatLatency(insights.latency_p95_ms)}
          />
          <MetricCell
            label={t('dashboard.metrics.uptime')}
            value={formatPercent(insights.uptime_percent)}
            accent={
              insights.uptime_percent != null
                ? insights.uptime_percent >= 99 ? 'text-emerald-600'
                  : insights.uptime_percent >= 95 ? 'text-amber-600'
                  : 'text-red-600'
                : undefined
            }
          />
          <MetricCell
            label={t('dashboard.metrics.loss')}
            value={formatLossRate(insights.loss_count, insights.sample_count)}
            accent={lossRate != null && lossRate > 0 ? 'text-red-600' : undefined}
          />
          <MetricCell
            label={t('dashboard.metrics.jitter')}
            value={jitter != null ? formatLatency(jitter) : '--'}
          />
          <MetricCell
            label={`${t('dashboard.metrics.samples')} / ${t('dashboard.metrics.losses')}`}
            value={`${insights.sample_count ?? 0} / ${insights.loss_count ?? 0}`}
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-x-3 gap-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <div className="h-2.5 w-12 bg-slate-200 rounded animate-pulse" />
              <div className="h-4 w-16 bg-slate-200 rounded animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* Health label */}
      {health !== 'paused' && health !== 'unknown' && (
        <div className="flex items-center gap-1.5 mt-auto">
          <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
          <span className={`text-[10px] font-medium uppercase tracking-wider ${
            health === 'healthy' ? 'text-emerald-600'
              : health === 'warning' ? 'text-amber-600'
              : 'text-red-600'
          }`}>
            {t(`dashboard.health.${health}`)}
          </span>
        </div>
      )}
    </div>
  )
}

export default TargetCard
