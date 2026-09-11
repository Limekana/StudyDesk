import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './index.css'
import App from './App.jsx'
import { ConfirmProvider } from './lib/ConfirmDialog.jsx'
import { initWebAnalytics } from './lib/webAnalytics.js'
import { supabase } from './lib/supabase.js'
import { watchForRecovery } from './lib/passwordRecovery.js'

// No-op unless this bundle was built by Vercel — see webAnalytics.js.
initWebAnalytics()

// #52 — before render, not in an effect. On web, supabase-js reads the
// recovery token out of the URL while the client is being constructed, so
// PASSWORD_RECOVERY can be emitted before React mounts; a listener added later
// misses it and the user lands in the app with the password they came to
// change. See lib/passwordRecovery.js.
watchForRecovery(supabase)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Outside <App> so any view can call useConfirm(), including the auth
        gate that renders before the app shell. */}
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>,
)
