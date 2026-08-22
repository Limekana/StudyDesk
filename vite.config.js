import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
})
