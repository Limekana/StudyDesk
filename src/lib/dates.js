// Locale-aware date and time formatting.
//
// The locale is read from the i18n singleton rather than threaded through
// arguments. Every call site renders inside a component that calls
// useTranslation(), and i18next re-renders those on 'languageChanged', so these
// helpers are re-invoked and pick up the new language on the next paint.
//
// Before this module the six formatting sites were split between hardcoded
// 'en-GB' and a correctly-threaded `lang`, and the time formatter was
// copy-pasted verbatim into three files. Locale policy now lives in one place.
import i18n from '../i18n';

// The formatting locale, deliberately not the same value as the i18n resource
// language. i18n resolves to a bare code ('en'); the device reports a region
// ('en-GB', 'en-IN', 'pt-BR'). When the two agree on language, prefer the
// device's regional tag so a UK user keeps "26 July" and a US user gets
// "July 26" — both reading the same English strings. When the user has picked a
// language that differs from the device, the region no longer applies.
// Exported since v1.9 (Item 8): the home-screen widget renders outside the
// WebView, so its date strings must be formatted here and handed over already
// done. Same rule, one definition.
export function formatLocale() {
  const lang = (i18n.language || 'en').split('-')[0];
  const nav = (typeof navigator !== 'undefined'
    && (navigator.languages?.[0] || navigator.language)) || '';
  return nav.split('-')[0] === lang ? nav : lang;
}

export function parseLocalDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// "26 Jul" — due dates on assignment and exam rows.
// `t` supplies the empty-date label; it is optional so the helper stays usable
// from contexts without a translator, where a blank reads better than English.
export function fmtDate(s, t) {
  if (!s) return t ? t('av.noDate') : '';
  return parseLocalDate(s).toLocaleDateString(formatLocale(), { day: 'numeric', month: 'short' });
}

// "Sat, 26 Jul 2026" — full dates on detail rows.
export function fmtDateFull(s) {
  if (!s) return '';
  return parseLocalDate(s).toLocaleDateString(formatLocale(), {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

// "14:30" — session start times.
// hour12:false pins the 24-hour clock the app has always shown. Dropping it
// would flip en users to "02:30 PM", which is a clock-convention change rather
// than the localisation fix intended here.
export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(formatLocale(), {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// "Sunday 26 July" — the main screen header.
export function fmtToday(date = new Date()) {
  return date.toLocaleDateString(formatLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Local YYYY-MM-DD for a Date, without the UTC shift `toISOString` would
 *  apply. Moved here from App.jsx (SD-6) alongside addDays, which calls it. */
export function toLocalISO(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/** `s` shifted by `n` days, as a local YYYY-MM-DD string. Moved here from
 *  App.jsx (SD-6): it is a date helper, and both of the functions it calls
 *  already live in this module. */
export function addDays(s, n) {
  const d = parseLocalDate(s);
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}
