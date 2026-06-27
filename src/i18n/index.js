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

export const SUPPORTED_LANGS = ['en', 'fi', 'fr', 'de', 'es', 'zh'];

export const LANG_STORAGE_KEY = 'limecore_lang';

/** Native (endonym) display names for the in-app language switcher. */
export const LANGUAGE_NAMES = {
  en: 'English',
  fi: 'Suomi',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  zh: '中文',
};

function isSupported(code) {
  return SUPPORTED_LANGS.includes(code);
}

export function detectLanguage() {
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

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    fi: { translation: fi },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
    zh: { translation: zh },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGS,
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
  react: { useSuspense: false },
});

export default i18n;
