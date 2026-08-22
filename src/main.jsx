import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './index.css'
import App from './App.jsx'
import { ConfirmProvider } from './lib/ConfirmDialog.jsx'
import { initWebAnalytics } from './lib/webAnalytics.js'

// No-op unless this bundle was built by Vercel — see webAnalytics.js.
initWebAnalytics()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Outside <App> so any view can call useConfirm(), including the auth
        gate that renders before the app shell. */}
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>,
)
