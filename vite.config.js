import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This config is ESM, so __dirname does not exist. The multi-entry input below
// needs absolute paths.
const __dirname = dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  // See src/lib/webAnalytics.js for why this is a build-time flag rather than
  // a runtime check. `VERCEL` is set by Vercel on every build it runs, and is
  // absent locally, in the Electron desktop build, and on F-Droid's builder —
  // so the analytics import is compiled out of all three.
  define: {
    'import.meta.env.VITE_WEB_ANALYTICS': JSON.stringify(process.env.VERCEL === '1'),
  },
  build: {
    rollupOptions: {
      // Two entries: the app, and the desktop glance widget's own renderer
      // (v1.11). The widget is a separate Electron BrowserWindow, so it needs
      // its own HTML document — it is not a route inside the app.
      //
      // This ships widget.html in every build, including the Android one where
      // nothing can open it. Measured before accepting: the widget's own entry
      // chunk is small because React, i18next and supabase-js are already in
      // shared chunks the app pulls anyway, so gating it out per-platform would
      // buy back very little and cost a build-mode matrix where the desktop and
      // web outputs differ.
      input: {
        main: resolve(__dirname, 'index.html'),
        widget: resolve(__dirname, 'widget.html'),
      },
    },
  },
})
