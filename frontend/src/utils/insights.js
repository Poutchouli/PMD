export function buildTimelineData(insights) {
  if (!insights?.timeline?.length) return []
  const spanMs = insights.window_start && insights.window_end
    ? new Date(insights.window_end).getTime() - new Date(insights.window_start).getTime()
    : null
  const showDate = spanMs !== null && spanMs > 24 * 60 * 60 * 1000

  return insights.timeline.map((point) => {
    const date = new Date(point.bucket)
    const label = showDate
      ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const lossRatePct = Number(((point.loss_rate ?? 0) * 100).toFixed(2))
    return {
      bucket: point.bucket,
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

const HEALTH_THRESHOLDS = {
  healthy: { minUptime: 99, maxLoss: 1, maxLatency: 100 },
  warning: { minUptime: 95, maxLoss: 5, maxLatency: 200 },
}

export function computeHealthStatus(insights, isActive) {
  if (!isActive) return 'paused'
  if (!insights || insights.sample_count === 0) return 'unknown'

  const uptime = insights.uptime_percent ?? 0
  const lossRate = insights.sample_count > 0
    ? (insights.loss_count / insights.sample_count) * 100
    : 0
  const avgLatency = insights.latency_avg_ms ?? 0

  const h = HEALTH_THRESHOLDS.healthy
  if (uptime >= h.minUptime && lossRate < h.maxLoss && avgLatency < h.maxLatency) {
    return 'healthy'
  }

  const w = HEALTH_THRESHOLDS.warning
  if (uptime >= w.minUptime && lossRate < w.maxLoss && avgLatency < w.maxLatency) {
    return 'warning'
  }

  return 'critical'
}

export function bucketSecondsForWindow(windowMinutes) {
  if (windowMinutes <= 15) return 30
  if (windowMinutes <= 60) return 60
  if (windowMinutes <= 240) return 120
  if (windowMinutes <= 720) return 300
  if (windowMinutes <= 1440) return 900
  if (windowMinutes <= 7 * 1440) return 3600
  if (windowMinutes <= 30 * 1440) return 7200
  return 21_600
}
