import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './index.css'
import App from './App.jsx'
import { ConfirmProvider } from './lib/ConfirmDialog.jsx'
import { initWebAnalytics } from './lib/webAnalytics.js'
import { supabase } from './lib/supabase.js'
import { watchForRecovery } from './lib/passwordRecovery.js'
import ErrorBoundary from './features/errors/ErrorBoundary.jsx'
import { notePolicyBaseline } from './lib/policyNotice.js'
import { installGlobalErrorHandlers } from './lib/errorReports.js'

// No-op unless this bundle was built by Vercel — see webAnalytics.js.
initWebAnalytics()

// #52 — before render, not in an effect. On web, supabase-js reads the
// recovery token out of the URL while the client is being constructed, so
// PASSWORD_RECOVERY can be emitted before React mounts; a listener added later
// misses it and the user lands in the app with the password they came to
// change. See lib/passwordRecovery.js.
watchForRecovery(supabase)

// v1.16 (limecore#16) — errors outside render (handlers, timers, promises),
// reported only while the Settings switch is on; see lib/errorReports.js.
installGlobalErrorHandlers()
// Before onboarding can run: a fresh install starts on the current policy.
notePolicyBaseline()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Outermost, so a throw anywhere below lands on the recovery screen
        instead of a blank page (limecore#16). */}
    <ErrorBoundary>
      {/* Outside <App> so any view can call useConfirm(), including the auth
          gate that renders before the app shell. */}
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ErrorBoundary>
  </StrictMode>,
)
