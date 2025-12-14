import { Activity, Lock, User } from 'lucide-react'
import { useTranslation } from '../../i18n/LanguageProvider'
import LanguageSelector from '../common/LanguageSelector'

function LoginScreen({ form, onChange, onSubmit, error, isLoading }) {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white/10 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between gap-6 mb-6">
          <div className="flex items-center gap-3">
            <div className="bg-slate-900 text-white p-2 rounded-xl">
              <Activity className="w-6 h-6" />
            </div>
            <div>
              <p className="text-lg font-semibold text-white">PingMeDaddy</p>
              <p className="text-sm text-slate-300">{t('auth.subtitle')}</p>
            </div>
          </div>
          <LanguageSelector variant="stacked" />
        </div>
        {error && (
          <div className="mb-4 text-sm text-red-300 bg-red-500/10 border border-red-400 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <form className="space-y-5" onSubmit={onSubmit}>
          <div>
            <label className="text-sm font-medium text-slate-200">{t('auth.usernameLabel')}</label>
            <div className="relative mt-1">
              <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg pl-10 pr-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent placeholder:text-slate-500"
                placeholder={t('auth.usernamePlaceholder')}
                value={form.username}
                onChange={(event) => onChange((prev) => ({ ...prev, username: event.target.value }))}
                autoComplete="username"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-slate-200">{t('auth.passwordLabel')}</label>
            <div className="relative mt-1">
              <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg pl-10 pr-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent placeholder:text-slate-500"
                placeholder={t('auth.passwordPlaceholder')}
                value={form.password}
                onChange={(event) => onChange((prev) => ({ ...prev, password: event.target.value }))}
                autoComplete="current-password"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={isLoading || !form.username || !form.password}
            className="w-full flex items-center justify-center gap-2 bg-slate-100 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-white transition disabled:opacity-60"
          >
            {isLoading ? t('auth.submitLoading') : t('auth.submit')}
          </button>
          <p className="text-xs text-slate-400 text-center">
            {t('auth.hint')}
          </p>
        </form>
      </div>
    </div>
  )
}

export default LoginScreen
