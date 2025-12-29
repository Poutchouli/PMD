import { useMemo } from 'react'
import { useTranslation } from '../../i18n/LanguageProvider'
import { formatDateTime, formatLatency } from '../../utils/formatters'

const MAX_VISIBLE_ROWS = 20
const APPROX_ROW_HEIGHT_PX = 42

function LogsTable({ logs }) {
  const { t } = useTranslation()
  const rows = useMemo(() => logs ?? [], [logs])
  const maxHeight = MAX_VISIBLE_ROWS * APPROX_ROW_HEIGHT_PX

  if (!rows.length) {
    return <div className="p-5 text-sm text-slate-500">{t('logs.empty')}</div>
  }

  return (
    <div className="overflow-y-auto" style={{ maxHeight }}>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500 sticky top-0 z-10">
          <tr>
            <th className="text-left px-4 py-2 font-semibold uppercase tracking-wide text-[11px]">{t('logs.headers.time')}</th>
            <th className="text-left px-4 py-2 font-semibold uppercase tracking-wide text-[11px]">{t('logs.headers.latency')}</th>
            <th className="text-left px-4 py-2 font-semibold uppercase tracking-wide text-[11px]">{t('logs.headers.status')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((log) => (
            <tr key={`${log.time}-${log.latency_ms ?? 'loss'}`} className="bg-white hover:bg-slate-50 transition-colors">
              <td className="px-4 py-2 whitespace-nowrap font-mono text-slate-600">{formatDateTime(log.time)}</td>
              <td className="px-4 py-2 text-slate-700">{log.packet_loss ? '--' : formatLatency(log.latency_ms)}</td>
              <td className="px-4 py-2">
                {log.packet_loss ? (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    {t('logs.timeout')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    {t('logs.ok')}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default LogsTable
