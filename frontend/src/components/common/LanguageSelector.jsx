import { useTranslation } from '../../i18n/LanguageProvider'

function LanguageSelector({ variant = 'inline', className = '' }) {
  const { languages, locale, setLocale, t } = useTranslation()
  const baseClasses =
    'border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 transition-colors'

  if (variant === 'stacked') {
    return (
      <div className={`space-y-1 ${className}`}>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-300">
          {t('language.selector')}
        </span>
        <select
          className={`w-full bg-slate-900/60 border-slate-700 text-slate-100 py-2 px-3 ${baseClasses}`}
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
        >
          {languages.map((language) => (
            <option key={language.code} value={language.code} className="text-slate-900">
              {language.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="text-xs font-medium text-slate-500 hidden sm:inline">{t('language.selector')}</span>
      <select
        className={`bg-white border-slate-200 text-slate-700 py-1.5 px-2 ${baseClasses}`}
        value={locale}
        aria-label={t('language.selector')}
        onChange={(event) => setLocale(event.target.value)}
      >
        {languages.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export default LanguageSelector
