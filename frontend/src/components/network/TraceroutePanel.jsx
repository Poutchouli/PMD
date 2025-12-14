import { formatDateTime, formatLatency } from '../../utils/formatters'
import { useTranslation } from '../../i18n/LanguageProvider'

function TraceroutePanel({ onRun, isLoading, error, result }) {
  const { t } = useTranslation()
  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col">
      <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-700 text-sm">{t('traceroute.title')}</h3>
          <p className="text-xs text-slate-500">{t('traceroute.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={isLoading}
          className="px-3 py-1.5 text-xs font-semibold rounded-md bg-slate-900 text-white hover:bg-slate-700 transition disabled:opacity-60"
        >
          {isLoading ? t('traceroute.running') : t('traceroute.run')}
        </button>
      </div>
      <div className="p-5 space-y-4 flex-1 flex flex-col">
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 p-3 rounded-md">{error}</div>
        )}
        {result ? (
          <>
            <p className="text-xs text-slate-500">
              {t('traceroute.lastRun', {
                time: formatDateTime(result.finished_at),
                hops: result.hops.length,
                duration: Math.round(result.duration_ms),
              })}
            </p>
            <div className="overflow-x-auto border border-slate-100 rounded-md flex-1">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">{t('traceroute.columns.hop')}</th>
                    <th className="px-3 py-2 text-left">{t('traceroute.columns.node')}</th>
                    <th className="px-3 py-2 text-left">{t('traceroute.columns.ip')}</th>
                    <th className="px-3 py-2 text-right">{t('traceroute.columns.latency')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.hops.map((hop) => (
                    <tr key={hop.hop} className={hop.is_timeout ? 'bg-amber-50' : 'bg-white'}>
                      <td className="px-3 py-1.5 font-mono text-slate-500">{hop.hop}</td>
                      <td className="px-3 py-1.5 text-slate-700">{hop.host ?? t('traceroute.timeoutHost')}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-500">{hop.ip ?? t('traceroute.timeoutIp')}</td>
                      <td className="px-3 py-1.5 text-right text-slate-700">
                        {hop.is_timeout ? t('traceroute.timeoutIp') : formatLatency(hop.rtt_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-400 font-mono">{result.ip}</p>
          </>
        ) : (
          <div className="text-sm text-slate-500 flex-1 flex items-center">{t('traceroute.empty')}</div>
        )}
      </div>
    </div>
  )
}

export default TraceroutePanel
