import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts'
import ChartPlaceholder from '../common/ChartPlaceholder'
import { useTranslation } from '../../i18n/LanguageProvider'

function LossTimelineChart({ data, isLoading }) {
  const { t } = useTranslation()
  if (isLoading) {
    return <ChartPlaceholder message={t('placeholders.lossLoading')} heightClass="h-56" />
  }
  if (!data.length) {
    return <ChartPlaceholder message={t('placeholders.lossEmpty')} heightClass="h-56" />
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis dataKey="label" minTickGap={24} />
          <YAxis unit=" %" width={50} domain={[0, 'auto']} />
          <RechartsTooltip
            formatter={(value) => [
              `${typeof value === 'number' ? value.toFixed(1) : value} %`,
              t('timeline.loss'),
            ]}
            labelFormatter={(label, payload) => payload?.[0]?.payload.fullLabel ?? label}
          />
          <Bar
            dataKey="lossRatePct"
            name={`${t('timeline.loss')} (%)`}
            fill="#fb923c"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export default LossTimelineChart
