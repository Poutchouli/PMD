import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import ChartPlaceholder from '../common/ChartPlaceholder'
import { formatLatency, formatPercent } from '../../utils/formatters'

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

export default LatencyTimelineChart
