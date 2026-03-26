function SkeletonBlock({ className }) {
  return <div className={`animate-pulse bg-slate-200 rounded ${className ?? ''}`} />
}

function SkeletonCard() {
  return (
    <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm space-y-2">
      <SkeletonBlock className="h-3 w-20" />
      <SkeletonBlock className="h-7 w-24" />
      <SkeletonBlock className="h-3 w-32" />
    </div>
  )
}

function SkeletonChart({ heightClass }) {
  return (
    <div className={`${heightClass ?? 'h-72'} bg-slate-50 border border-dashed border-slate-200 rounded-lg flex flex-col items-center justify-center gap-3 p-6`}>
      <div className="w-full flex items-end gap-1 justify-center h-24">
        {[40, 65, 50, 80, 55, 70, 45, 60, 75, 50, 65, 55].map((h, i) => (
          <SkeletonBlock key={i} className="w-4 rounded-sm" style={{ height: `${h}%` }} />
        ))}
      </div>
      <SkeletonBlock className="h-3 w-32" />
    </div>
  )
}

function SkeletonTableRow({ cols }) {
  return (
    <tr className="bg-white">
      {Array.from({ length: cols ?? 3 }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <SkeletonBlock className="h-3 w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  )
}

function SkeletonTargetRow() {
  return (
    <tr className="border-l-4 border-l-transparent">
      <td className="px-6 py-4"><SkeletonBlock className="h-6 w-16 rounded" /></td>
      <td className="px-6 py-4 space-y-2">
        <SkeletonBlock className="h-4 w-36" />
        <SkeletonBlock className="h-3 w-48" />
      </td>
      <td className="px-6 py-4"><SkeletonBlock className="h-3 w-8" /></td>
      <td className="px-6 py-4"><SkeletonBlock className="h-3 w-20" /></td>
      <td className="px-6 py-4 text-right"><SkeletonBlock className="h-5 w-5 ml-auto" /></td>
    </tr>
  )
}

export { SkeletonBlock, SkeletonCard, SkeletonChart, SkeletonTableRow, SkeletonTargetRow }
