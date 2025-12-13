export function formatLatency(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--'
  return `${value.toFixed(1)} ms`
}

export function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--'
  return `${value.toFixed(1)} %`
}

export function formatWindowLabel(minutes) {
  if (minutes >= 60) {
    const hours = minutes / 60
    return `${hours % 1 === 0 ? hours : hours.toFixed(1)} h`
  }
  return `${minutes} min`
}

export function formatWindowRange(insights) {
  if (!insights?.window_start || !insights?.window_end) return '--'
  return `${formatDateTime(insights.window_start)} -> ${formatDateTime(insights.window_end)}`
}

export function formatDateTime(value) {
  if (!value) return '--'
  return new Date(value).toLocaleString()
}
