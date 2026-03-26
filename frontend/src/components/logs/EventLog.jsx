import { useTranslation } from '../../i18n/LanguageProvider'
import { formatDateTime } from '../../utils/formatters'
import { Download } from 'lucide-react'

function EventLog({
  events,
  isLoading,
  error,
  rangeLabel,
  onSelectPreset,
  selectedPreset,
  presets,
  onLoadMore,
  hasMore,
  isLoadingMore,
  onExport,
  isExporting,
  exportError,
}) {
  const { t } = useTranslation()

  const subtitle = rangeLabel
    ? t('history.eventsSubtitleRange', { range: rangeLabel })
    : t('history.eventsSubtitle')

  let content = null
  if (isLoading) {
    content = <p className="text-sm text-slate-500">{t('history.eventsLoading')}</p>
  } else if (error) {
    content = <div className="text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded-md">{error}</div>
  } else if (!events?.length) {
    content = <p className="text-sm text-slate-500">{t('history.eventsEmpty')}</p>
  } else {
    content = (
      <ol className="relative space-y-4 pl-4">
        <span className="absolute left-0 top-2 bottom-2 w-px bg-slate-200" aria-hidden />
        {events.map((event) => (
          <li key={event.id} className="relative pl-4">
            <span className="absolute -left-4 top-2 h-2.5 w-2.5 rounded-full bg-slate-400 ring-4 ring-white" aria-hidden />
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-800">{event.message}</p>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                  {event.event_type}
                </span>
              </div>
              <span className="text-[11px] font-mono text-slate-500 whitespace-nowrap">{formatDateTime(event.created_at)}</span>
            </div>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex flex-col gap-3">
        <div>
          <h3 className="font-semibold text-slate-700 text-sm">{t('history.eventsTitle')}</h3>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 bg-white rounded-full p-1 border border-slate-200">
            {presets.map((preset) => (
              <button
                key={String(preset.value)}
                type="button"
                onClick={() => onSelectPreset?.(preset.value)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-full transition ${selectedPreset === preset.value ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {t(preset.labelKey)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 bg-white px-2 py-1 rounded-full border border-slate-200">{t('history.eventsTag')}</span>
            <button
              type="button"
              onClick={onExport}
              disabled={isExporting}
              className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 bg-white border border-slate-300 px-3 py-1.5 rounded-full hover:bg-slate-100 transition disabled:opacity-60"
            >
              <Download className="w-3.5 h-3.5" />
              {isExporting ? t('history.eventsExporting') : t('history.eventsExport')}
            </button>
          </div>
        </div>
      </div>
      {exportError && <p className="px-5 pt-2 text-xs text-red-500">{exportError}</p>}
      <div className="p-5 space-y-3">
        {content}
        {!isLoading && !error && events?.length > 0 && hasMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="w-full px-3 py-2 rounded-md text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition disabled:opacity-60"
          >
            {isLoadingMore ? t('history.loadingMore') : t('history.loadMore')}
          </button>
        )}
      </div>
    </div>
  )
}

export default EventLog
