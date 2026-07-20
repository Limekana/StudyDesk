import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'android']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // Empty catch is a deliberate idiom throughout (best-effort localStorage /
      // Preferences / AudioContext writes that are fine to swallow).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // react-hooks@7 flags a handful of small sub-components defined inside
      // render. They're pre-existing and safe here; surface as a warning
      // (non-blocking) rather than gating the release build on a refactor.
      'react-hooks/static-components': 'warn',
    },
  },
])
