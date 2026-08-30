// Theme selection — "free" (cream paper) plus the two supporter themes.
//
// The free theme is the app's brand identity and is defined on bare `:root`.
// Both paid themes are additive `[data-theme]` token scopes over the same
// token names, so removing the attribute returns the app to cream exactly.
// That is the regression test the design handoff asks for: no `data-theme`,
// no visual difference.
//
// Applying the attribute is deliberately split in two:
//   - the pre-paint pass in `index.html` sets it from storage before the
//     stylesheet paints, so a slate user never sees a frame of cream;
//   - this module owns every change after that, and is the only writer.

import { isEntitled } from "./entitlement";

export const FREE_THEME = "free";
export const PAID_THEMES = ["stacks", "slate"];
export const THEMES = [FREE_THEME, ...PAID_THEMES];

// Shared with the inline pre-paint script in index.html. If this key changes,
// change it there too — they are two readers of one value.
export const THEME_KEY = "studydesk.theme";

export function isPaidTheme(theme) {
  return PAID_THEMES.includes(theme);
}

// What the user last chose, regardless of whether they may currently use it.
// Kept separate from `activeTheme()` so a lapsed supporter who renews gets
// their theme back rather than having silently been reset to cream.
export function preferredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.includes(v) ? v : FREE_THEME;
  } catch {
    return FREE_THEME;
  }
}

// What should actually render. A paid theme with no entitlement falls back to
// free silently — never to a half-applied theme.
export function activeTheme() {
  const pref = preferredTheme();
  if (isPaidTheme(pref) && !isEntitled()) return FREE_THEME;
  return pref;
}

// Single writer of the attribute. Free removes it outright rather than setting
// `data-theme="free"`, so the "attribute absent" regression check above is the
// literal shipped state for free users, not an approximation of it.
export function applyTheme(theme = activeTheme()) {
  const el = document.documentElement;
  if (theme === FREE_THEME || !THEMES.includes(theme)) delete el.dataset.theme;
  else el.dataset.theme = theme;
  return theme;
}

export function setPreferredTheme(theme) {
  const next = THEMES.includes(theme) ? theme : FREE_THEME;
  try {
    if (next === FREE_THEME) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable — the choice just won't survive a relaunch */
  }
  return applyTheme(activeTheme());
}

// Re-resolve after anything that can change entitlement: sign-in, sign-out, a
// completed refresh. Cheap and idempotent, so call it freely.
export function syncTheme() {
  return applyTheme(activeTheme());
}

// Stable per-item jitter, shared by both themes' signature elements — Stacks'
// stamp rotation and Slate's chalk tilt. Seeded from the item id so a row
// keeps the same angle across re-renders and across relaunches; `Math.random()`
// here would make the whole list twitch on every state change.
//
// FNV-1a, 32-bit. Chosen over a sum-of-charCodes because ids in this app are
// UUIDs that share long prefixes, and a weak hash would give neighbouring rows
// near-identical angles — visibly a pattern rather than a hand.
export function seededTilt(id, maxDeg) {
  const s = String(id ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Map to (-maxDeg, +maxDeg) excluding a dead-on 0, which reads as a mistake
  // rather than a hand: the handoff is explicit that a stamp is never 0°.
  const unit = (h % 2000) / 1000 - 1; // -1 .. 0.999
  const signed = unit >= 0 ? unit + 0.15 : unit - 0.15;
  return Math.max(-maxDeg, Math.min(maxDeg, signed * maxDeg));
}

// ── Stacks: spine code and DATE DUE stamp ─────────────────────────────────
//
// Both are pure presentation, so they are derived here and handed to the row
// as data attributes plus two custom properties. That keeps the row markup
// theme-agnostic: under the free theme and under Slate the attributes are
// simply never drawn, because only the `[data-theme="stacks"]` rules read them.

// Three letters, uppercased, from the course name. Deliberately the first
// three rather than a consonant-squeeze ("MATHEMATICS" -> "MTH"): a squeeze
// reads well in English and produces nonsense in the other nine locales this
// app ships, and a spine label nobody can decode is worse than a blunt one.
export function spineCode(courseName) {
  const letters = String(courseName || "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
  return letters.slice(0, 3) || "—";
}

// Ink opacity scales with urgency, so a wall of stamps still reads as a
// gradient of pressure rather than a uniform block of violet.
function stampInk(days) {
  if (days == null || Number.isNaN(days)) return 0.5;
  if (days <= 2) return 1;
  if (days <= 7) return 0.9;
  if (days <= 14) return 0.7;
  if (days <= 20) return 0.55;
  return 0.5;
}

/**
 * Props for one Stacks list row. Spread onto the row element.
 *
 * `dueLabel` carries a real newline: the stamp is drawn by a `::after` whose
 * `content` is `attr(data-stamp)`, rendered with `white-space: pre-line`, so
 * the line breaks have to be in the attribute value itself.
 */
export function stacksRowProps({ id, courseName, courseIndex, dueDate, days, kind = "due", done = false }) {
  const props = {
    "data-spine": courseIndex ? `${spineCode(courseName)} ${courseIndex}` : spineCode(courseName),
  };
  if (!dueDate) return props;

  const d = new Date(dueDate);
  const when = Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" }).toUpperCase();

  const head = done ? "FILED" : kind === "exam" ? "EXAM" : "DATE DUE";
  const tail =
    done || days == null || Number.isNaN(days) || days < 0
      ? ""
      : `\n${days} ${days === 1 ? "DAY" : "DAYS"}`;

  props["data-stamp"] = done ? "FILED" : `${head}\n${when}${tail}`;
  props["data-stamp-kind"] = done ? "filed" : kind;
  props.style = {
    "--stamp-tilt": `${seededTilt(id, 4).toFixed(2)}deg`,
    "--stamp-ink": done ? 0.45 : stampInk(days),
  };
  return props;
}
