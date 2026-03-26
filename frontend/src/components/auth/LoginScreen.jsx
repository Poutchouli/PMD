import { Activity, LogIn } from 'lucide-react'
import { useTranslation } from '../../i18n/LanguageProvider'
import { useAuth } from '../../context/AuthContext'
import LanguageSelector from '../common/LanguageSelector'

function LoginScreen() {
  const { t } = useTranslation()
  const { login } = useAuth()

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
        <p className="text-sm text-slate-300 mb-6 text-center">
          {t('auth.hubLoginHint') || 'Connectez-vous via le Hub pour accéder à PingMeDaddy.'}
        </p>
        <button
          type="button"
          onClick={login}
          className="w-full flex items-center justify-center gap-2 bg-slate-100 text-slate-900 font-semibold py-2.5 rounded-lg hover:bg-white transition"
        >
          <LogIn className="w-4 h-4" />
          {t('auth.hubLogin') || 'Se connecter via le Hub'}
        </button>
      </div>
    </div>
  )
}

export default LoginScreen
