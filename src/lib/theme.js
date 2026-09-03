// Theme and mode selection.
//
// TWO INDEPENDENT AXES, and keeping them independent is the whole design:
//
//   THEME  — character.  free (cream paper) | stacks | slate     [paid]
//   MODE   — lighting.   light | dark | black                    [free, v1.13]
//
// The free theme is the app's brand identity and is defined on bare `:root`.
// Every other palette is an additive attribute scope over the same token
// names, so removing both attributes returns the app to cream exactly. That
// is the regression test the design handoff asks for: no `data-theme` and no
// `data-mode`, no visual difference.
//
// Mode only applies to the free theme. Stacks is a light theme by its own
// definition (manila card stock) and Slate is a dark one (a chalkboard);
// a "Stacks dark" would be a fourth palette nobody designed and a "Slate
// light" contradicts the theme. So `data-mode` is dropped whenever a paid
// theme is active — see `applyTheme`, which is the only writer of either
// attribute.
//
// Applying the attributes is deliberately split in two:
//   - the pre-paint pass in `index.html` sets them from storage before the
//     stylesheet paints, so a dark-mode user never sees a frame of cream;
//   - this module owns every change after that, and is the only writer.

import { isEntitled } from "./entitlement";

export const FREE_THEME = "free";
export const PAID_THEMES = ["stacks", "slate"];
export const THEMES = [FREE_THEME, ...PAID_THEMES];

export const LIGHT_MODE = "light";
export const DARK_MODES = ["dark", "black"];
export const MODES = [LIGHT_MODE, ...DARK_MODES];

// Shared with the inline pre-paint script in index.html. If either key
// changes, change it there too — they are two readers of one value.
export const THEME_KEY = "studydesk.theme";
export const MODE_KEY = "studydesk.mode";

export function isPaidTheme(theme) {
  return PAID_THEMES.includes(theme);
}

// Whether a given theme+mode pair renders dark overall. Callers outside CSS
// need this — the Android status bar and the Electron titlebar are painted
// natively and cannot read a custom property.
export function isDarkAppearance(theme = activeTheme(), mode = activeMode(theme)) {
  if (theme === "slate") return true;   // chalkboard
  if (theme === "stacks") return false; // card stock
  return DARK_MODES.includes(mode);
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

// The mode the user last chose. Unlike the theme this needs no entitlement
// check — dark is free, which is the point of the v1.13 decision.
export function preferredMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return MODES.includes(v) ? v : LIGHT_MODE;
  } catch {
    return LIGHT_MODE;
  }
}

// What mode should actually render. A paid theme carries its own lighting, so
// mode collapses to light (= "no data-mode attribute") while one is active.
// The PREFERENCE is untouched, so turning a paid theme off restores the dark
// mode the user was in rather than dumping them onto a bright cream page.
export function activeMode(theme = activeTheme()) {
  if (isPaidTheme(theme)) return LIGHT_MODE;
  return preferredMode();
}

// Single writer of both attributes. The default value removes the attribute
// outright rather than setting `data-theme="free"` / `data-mode="light"`, so
// the "attributes absent" regression check above is the literal shipped state
// for a free light user, not an approximation of it.
export function applyTheme(theme = activeTheme(), mode = activeMode(theme)) {
  const el = document.documentElement;

  if (theme === FREE_THEME || !THEMES.includes(theme)) delete el.dataset.theme;
  else el.dataset.theme = theme;

  if (mode === LIGHT_MODE || !MODES.includes(mode)) delete el.dataset.mode;
  else el.dataset.mode = mode;

  applyAppearanceChrome(isDarkAppearance(theme, mode));
  return { theme, mode };
}

export function setPreferredTheme(theme) {
  const next = THEMES.includes(theme) ? theme : FREE_THEME;
  try {
    if (next === FREE_THEME) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable — the choice just won't survive a relaunch */
  }
  return applyTheme();
}

export function setPreferredMode(mode) {
  const next = MODES.includes(mode) ? mode : LIGHT_MODE;
  try {
    if (next === LIGHT_MODE) localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, next);
  } catch {
    /* storage unavailable — see setPreferredTheme */
  }
  return applyTheme();
}

// Re-resolve after anything that can change entitlement: sign-in, sign-out, a
// completed refresh. Cheap and idempotent, so call it freely.
export function syncTheme() {
  return applyTheme();
}

// Self-wiring: entitlement.js announces every cache write, and a theme that
// depends on entitlement should follow it without each caller remembering to.
// Registered at module load — this module is imported by the app shell, so it
// is live for the whole session, and `applyTheme` is idempotent so a spurious
// event costs one attribute write.
if (typeof window !== "undefined") {
  window.addEventListener("studydesk-entitlement-change", () => {
    try { applyTheme(); } catch { /* never let a theme refresh break a sign-in */ }
  });
}

// ── Native chrome the stylesheet cannot reach ─────────────────────────────
//
// Two surfaces sit outside the WebView and therefore outside every token:
// Android's status bar and the `theme-color` the OS uses for the task
// switcher and (on web) the browser UI. Both have to be told, imperatively,
// which way the app just went.
//
// Android 15+ enforces edge-to-edge for SDK 35+ targets, so the status bar is
// drawn OVER the app: dark icons on a #000 ground is a genuinely blank strip
// with a clock somewhere in it. The `overlaysWebView:false` escape hatch is a
// no-op on this target (see the .topbar note in base.css), which is why the
// style has to be set rather than the bar being pushed out of the way.
//
// The StatusBar plugin is imported lazily and every failure is swallowed:
// this module is imported by the pre-paint path and on web/Electron the
// plugin is simply absent. A theme must never fail to apply because a native
// bar could not be restyled.
function applyAppearanceChrome(dark) {
  const meta = typeof document !== "undefined"
    ? document.querySelector('meta[name="theme-color"]')
    : null;
  if (meta) {
    // Read the resolved ground rather than repeating a hex here — this is the
    // one place outside CSS that needs the value, and duplicating it is how
    // the two drift apart.
    try {
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg")
        .trim();
      if (bg) meta.setAttribute("content", bg);
    } catch { /* getComputedStyle unavailable pre-paint — the next call wins */ }
  }

  import("@capacitor/status-bar")
    .then(async ({ StatusBar, Style }) => {
      // `Style.Dark` means "dark CONTENT" in some plugin versions and "dark
      // BACKGROUND" in others, which has burned this before. Capacitor 8's
      // documented contract is: Style.Dark = LIGHT TEXT for a dark background.
      // Verified against the installed plugin's own definitions.d.ts.
      await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });

      // The BAR ITSELF, for Android 14 and below.
      //
      // Both halves are needed because the app spans two regimes. minSdk is
      // 24 and targetSdk is 36:
      //   * Android 15+ ENFORCES edge-to-edge for SDK 35+ targets, so the
      //     WebView draws under the bar, `--bg` shows through it, and only
      //     the icon colour above matters. `setBackgroundColor` is a no-op.
      //   * Android 14 and below honour `statusBarColor`, which the app theme
      //     hardcodes to #F5F2ED in styles.xml. That is the right FIRST PAINT
      //     for the default light theme and completely wrong once the user
      //     picks Dark — a cream strip above a #16140f app.
      //
      // A literal is deliberately not repeated here: the value is read from
      // the resolved `--bg`, so the bar and the page cannot drift apart.
      try {
        const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
        // The plugin wants #rrggbb. A token that resolved to a keyword or an
        // rgb() — which none currently do, but which a future theme might —
        // is skipped rather than passed through to a native call that would
        // throw.
        if (/^#[0-9a-f]{6}$/i.test(bg)) await StatusBar.setBackgroundColor({ color: bg });
      } catch { /* pre-paint, or Android 15+ where this is a no-op anyway */ }
    })
    .catch(() => { /* web, Electron, or plugin not installed */ });
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
