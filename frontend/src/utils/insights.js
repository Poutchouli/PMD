export function buildTimelineData(insights) {
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

export function bucketSecondsForWindow(windowMinutes) {
  if (windowMinutes <= 15) return 30
  if (windowMinutes <= 60) return 60
  if (windowMinutes <= 240) return 120
  if (windowMinutes <= 720) return 300
  return 900
}
