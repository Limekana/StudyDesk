// Shared Limecore i18n setup (Phase 0). Same pattern across NCC / LimeLog /
// StudyDesk — see D:\emilh\Projects\limecore\I18N_GUIDE.md.
//
// Detection order (per the v1.6 plan):
//   1. localStorage override  — set by a future in-app language switcher
//   2. device locale          — in a Capacitor WebView, navigator.language
//                               reflects the Android system locale, so no
//                               native @capacitor/device plugin is needed
//   3. 'en' fallback
//
// v1.17 (limecore#18): only English, the fallback, is bundled. Each other
// language is its own chunk: the active one loads before first render (both
// entry points wait on `i18nReady`), the rest only when the user switches. The
// chunks are part of dist, so they ship inside the APK and load offline. Init
// itself is still synchronous, so no Suspense boundary is required
// (react.useSuspense = false).
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';

export const SUPPORTED_LANGS = ['en', 'fi', 'fr', 'de', 'es', 'zh', 'hi', 'pt', 'id', 'ar'];

// Spelled out rather than globbed, so a missing locale file fails the build
// instead of a user's first launch.
const LOADERS = {
  fi: () => import('./locales/fi.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  zh: () => import('./locales/zh.json'),
  hi: () => import('./locales/hi.json'),
  pt: () => import('./locales/pt.json'),
  id: () => import('./locales/id.json'),
  ar: () => import('./locales/ar.json'),
};

const LANG_STORAGE_KEY = 'limecore_lang';

/** Native (endonym) display names for the in-app language switcher. */
export const LANGUAGE_NAMES = {
  en: 'English',
  fi: 'Suomi',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  zh: '中文',
  hi: 'हिन्दी',
  pt: 'Português',
  id: 'Bahasa Indonesia',
  ar: 'العربية',
};

function isSupported(code) {
  return SUPPORTED_LANGS.includes(code);
}

function detectLanguage() {
  // 1. explicit override
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored && isSupported(stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode / WebView quirk) */
  }
  // 2. device locale (WebView reports the system locale here)
  const nav = (
    (typeof navigator !== 'undefined' &&
      (navigator.languages?.[0] || navigator.language)) ||
    'en'
  ).toLowerCase();
  const base = nav.split('-')[0];
  if (isSupported(base)) return base;
  // 3. fallback
  return 'en';
}

/** Persist + apply a manual language choice (for the future Settings switcher). */
export async function setLanguage(lang) {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore persistence failure — still switch in-memory */
  }
  await applyLanguage(lang);
}

async function loadLanguage(lang) {
  if (lang === 'en' || i18n.hasResourceBundle(lang, 'translation')) return;
  const { default: strings } = await LOADERS[lang]();
  i18n.addResourceBundle(lang, 'translation', strings);
}

// Loading is async, so two quick taps could finish out of order and leave the
// app in the first language while storage holds the second. The last request
// wins.
let requested;

// Boot and a live switch share this path, so <html dir> follows a switch too.
// It used to be set at boot only, and choosing Arabic left the layout
// left-to-right until a restart (#95).
async function applyLanguage(lang) {
  requested = lang;
  await loadLanguage(lang);
  if (requested !== lang) return;
  applyDirection(lang);
  await i18n.changeLanguage(lang);
}


/** Languages that render right-to-left. Arabic is the only one so far. */
const RTL_LANGS = ['ar'];

function isRtl(lang) {
  return RTL_LANGS.includes(lang.split('-')[0]);
}

/**
 * Mirror the document for RTL languages.
 *
 * Set on <html> rather than a React root so it covers portals (modals, the
 * sign-out confirm) too, and so CSS logical properties resolve correctly for
 * the whole tree. `lang` goes on at the same time — it drives hyphenation and
 * font fallback, which matters for Devanagari and Arabic script.
 */
function applyDirection(lang) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  el.dir = isRtl(lang) ? 'rtl' : 'ltr';
  el.lang = lang.split('-')[0];
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGS,
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
  react: { useSuspense: false },
});

/**
 * Resolves once the detected language is loaded and active, with <html dir>
 * and <html lang> set for it. Never rejects: if the chunk cannot load, the app
 * starts in English rather than not starting.
 */
export const i18nReady = applyLanguage(detectLanguage()).catch(() => {});

export default i18n;
