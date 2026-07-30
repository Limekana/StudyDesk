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
// Resources are bundled (imported below), so init is synchronous and no
// Suspense boundary is required (react.useSuspense = false).
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import fi from './locales/fi.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import zh from './locales/zh.json';
import hi from './locales/hi.json';
import pt from './locales/pt.json';
import id from './locales/id.json';
import ar from './locales/ar.json';

export const SUPPORTED_LANGS = ['en', 'fi', 'fr', 'de', 'es', 'zh', 'hi', 'pt', 'id', 'ar'];

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
export function setLanguage(lang) {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore persistence failure — still switch in-memory */
  }
  i18n.changeLanguage(lang);
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
  resources: {
    en: { translation: en },
    fi: { translation: fi },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
    zh: { translation: zh },
    hi: { translation: hi },
    pt: { translation: pt },
    id: { translation: id },
    ar: { translation: ar },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGS,
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
  react: { useSuspense: false },
});

// Set <html dir>/<html lang> for the language i18n actually booted with.
applyDirection(i18n.language || 'en');

export default i18n;
