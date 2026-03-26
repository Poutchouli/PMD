function ChartPlaceholder({ message, heightClass }) {
  return (
    <div className={`${heightClass} bg-slate-50 border border-dashed border-slate-200 rounded-lg flex flex-col items-center justify-center gap-3 p-6`}>
      <div className="w-full flex items-end gap-1 justify-center h-20">
        {[40, 65, 50, 80, 55, 70, 45, 60, 75, 50, 65, 55].map((h, i) => (
          <div
            key={i}
            className="w-4 rounded-sm animate-pulse bg-slate-200"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <p className="text-sm text-slate-400">{message}</p>
    </div>
  )
}

export default ChartPlaceholder
