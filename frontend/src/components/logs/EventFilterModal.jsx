import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '../../i18n/LanguageProvider'

const ALL_EVENT_TYPES = ['start', 'stop', 'shutdown', 'disconnect', 'failure', 'recovery']

function EventFilterModal({ open, onClose, activeFilters, onApply, isSaving }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(new Set(ALL_EVENT_TYPES))

  useEffect(() => {
    if (!open) return
    if (activeFilters && activeFilters.length > 0) {
      setSelected(new Set(activeFilters))
    } else {
      setSelected(new Set(ALL_EVENT_TYPES))
    }
  }, [open, activeFilters])

  const toggle = useCallback((type) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === ALL_EVENT_TYPES.length) return new Set()
      return new Set(ALL_EVENT_TYPES)
    })
  }, [])

  const handleApply = useCallback(() => {
    const arr = Array.from(selected)
    // If all selected or none selected, pass null (= no filter)
    if (arr.length === ALL_EVENT_TYPES.length || arr.length === 0) {
      onApply(null)
    } else {
      onApply(arr)
    }
  }, [onApply, selected])

  if (!open) return null

  const allChecked = selected.size === ALL_EVENT_TYPES.length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50">
          <h3 className="font-semibold text-slate-800 text-sm">{t('history.eventFilterTitle')}</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-slate-500">{t('history.eventFilterDesc')}</p>

          <label className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-slate-50 transition cursor-pointer border border-slate-200">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              className="h-4 w-4 rounded border-slate-300 text-slate-800 focus:ring-slate-500"
            />
            <span className="text-sm font-semibold text-slate-700">{t('history.eventFilterAll')}</span>
          </label>

          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
            {ALL_EVENT_TYPES.map((type) => (
              <label
                key={type}
                className="flex items-center gap-3 py-2.5 px-3 hover:bg-slate-50 transition cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(type)}
                  onChange={() => toggle(type)}
                  className="h-4 w-4 rounded border-slate-300 text-slate-800 focus:ring-slate-500"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-slate-700">{t(`history.eventType.${type}`)}</span>
                  <p className="text-[11px] text-slate-400 leading-tight">{t(`history.eventTypeDesc.${type}`)}</p>
                </div>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                  {type}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition"
          >
            {t('history.eventFilterCancel')}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={isSaving}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-800 rounded-md hover:bg-slate-700 transition disabled:opacity-60"
          >
            {isSaving ? t('history.eventFilterSaving') : t('history.eventFilterApply')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default EventFilterModal
