import { useTranslation } from '../../i18n/LanguageProvider'
import { formatDateTime } from '../../utils/formatters'

function EventLog({ events, isLoading, error, rangeLabel }) {
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
      <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-700 text-sm">{t('history.eventsTitle')}</h3>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        <span className="text-xs text-slate-500 bg-white px-2 py-1 rounded-full border border-slate-200">{t('history.eventsTag')}</span>
      </div>
      <div className="p-5">{content}</div>
    </div>
  )
}

export default EventLog
