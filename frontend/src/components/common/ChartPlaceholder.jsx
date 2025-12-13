function ChartPlaceholder({ message, heightClass }) {
  return (
    <div className={`${heightClass} bg-slate-50 border border-dashed border-slate-200 rounded-lg flex items-center justify-center`}>
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  )
}

export default ChartPlaceholder
