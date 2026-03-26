function TargetCardSkeleton() {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 border-l-4 border-l-slate-200 p-4 flex flex-col gap-3 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-slate-200" />
          <div className="h-5 w-32 bg-slate-200 rounded" />
        </div>
        <div className="h-5 w-14 bg-slate-200 rounded" />
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-3 gap-x-3 gap-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-2.5 w-12 bg-slate-200 rounded" />
            <div className="h-4 w-16 bg-slate-200 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default TargetCardSkeleton
