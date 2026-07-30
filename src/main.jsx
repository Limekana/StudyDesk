import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './index.css'
import App from './App.jsx'
import { ConfirmProvider } from './lib/ConfirmDialog.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Outside <App> so any view can call useConfirm(), including the auth
        gate that renders before the app shell. */}
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </StrictMode>,
)
