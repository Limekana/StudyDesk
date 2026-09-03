// Contrast gate — WCAG 2.1 relative luminance, computed over the real token
// values in the real stylesheets.
//
// Why this exists rather than a table in a comment: v1.13 adds two dark
// palettes and a notebook that has to stay readable in five of them, and the
// project has already shipped one invisible surface from a colour that was
// reasoned about instead of measured (`phaseColor`, see base.css). A number
// in a comment goes stale the first time someone nudges a hex; this reads the
// stylesheet.
//
// It parses the token blocks directly — no CSS engine, no browser. That
// limits it to literal colours, which is exactly the scope that matters:
// every pair checked below is ink-on-ground, and both sides are literals by
// the rules in base.css.
//
// Run: `node scripts/check-contrast.mjs` (wired into `npm run check:contrast`,
// which the lint gate calls).

import { readFileSync } from "node:fs";

// ── Colour maths ──────────────────────────────────────────────────────────

function parseColor(raw) {
  const v = String(raw).trim();

  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ];
  }

  const rgba = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (rgba) {
    return [
      Number(rgba[1]),
      Number(rgba[2]),
      Number(rgba[3]),
      rgba[4] === undefined ? 1 : Number(rgba[4]),
    ];
  }

  return null; // `none`, a var(), a keyword — not a literal we can measure
}

// Flatten a translucent colour onto its ground. Contrast is only meaningful
// against what is actually behind the pixel, and several tokens here are
// deliberately alpha washes.
function over(fg, bg) {
  const a = fg[3];
  if (a >= 1) return fg;
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg, bg) {
  const a = luminance(over(fg, bg));
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Token extraction ──────────────────────────────────────────────────────
//
// Pull `--name: value;` pairs out of the block introduced by `selector {`.
// Deliberately simple: these files are hand-written token blocks, not
// arbitrary CSS, and a real parser would be more machinery than the job.

// Strip /* ... */ before anything else. This is not tidiness — the token
// blocks in this project are heavily commented, and several comments contain
// prose like "Not --text: the button ground is browner", which a naive
// `--name: value;` scan reads as a declaration and uses to OVERWRITE the real
// token. That produced a confident, wrong contrast report on the first run of
// this script: --bg in Slate came back as the sentence documenting it.
//
// Replaced with a space rather than deleted so two declarations that were
// only separated by a comment cannot be glued into one.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function tokensFor(rawCss, selector) {
  const css = stripComments(rawCss);
  const at = css.indexOf(selector);
  if (at === -1) return null;

  const open = css.indexOf("{", at);
  if (open === -1) return null;

  // Walk to the matching brace so a nested block cannot truncate the scan.
  let depth = 0;
  let end = -1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  const body = css.slice(open + 1, end);
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const base = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
const modes = readFileSync(new URL("../src/styles/modes.css", import.meta.url), "utf8");
const themes = readFileSync(new URL("../src/styles/themes.css", import.meta.url), "utf8");

// The light palette is spread over two `:root` blocks in base.css (the
// original one-liner and the v1.13 semantic block), so merge every `:root`
// occurrence rather than taking the first.
function allRootTokens(rawCss) {
  const css = stripComments(rawCss);
  const merged = {};
  let from = 0;
  for (;;) {
    const at = css.indexOf(":root", from);
    if (at === -1) break;
    // Already comment-free, so tokensFor's own strip is a no-op here.
    const got = tokensFor(css.slice(at), ":root");
    Object.assign(merged, got || {});
    from = at + 5;
  }
  return merged;
}

const light = allRootTokens(base);
const dark = { ...light, ...tokensFor(modes, '[data-mode="dark"]') };
const black = { ...light, ...tokensFor(modes, '[data-mode="black"]') };
const stacks = { ...light, ...tokensFor(themes, '[data-theme="stacks"]') };
const slate = { ...light, ...tokensFor(themes, '[data-theme="slate"]') };

const PALETTES = { light, dark, black, stacks, slate };

// ── The pairs that must hold ──────────────────────────────────────────────
//
// `min` follows WCAG: 4.5 for body text, 3.0 for large text and for the
// non-text parts of a control. Rows marked `decorative` are checked for a
// CEILING instead — ruling louder than the writing on it is its own defect,
// and the notebook handoff is explicit about it.

const CHECKS = [
  { fg: "--text", bg: "--bg", min: 4.5, what: "body ink on page" },
  { fg: "--text", bg: "--surface", min: 4.5, what: "body ink on panel" },
  { fg: "--muted", bg: "--bg", min: 4.5, what: "muted text on page" },
  { fg: "--muted2", bg: "--bg", min: 4.5, what: "dimmest text on page" },
  { fg: "--muted", bg: "--surface", min: 4.5, what: "muted text on panel" },
  { fg: "--muted2", bg: "--surface", min: 4.5, what: "dimmest text on panel" },
  { fg: "--danger", bg: "--bg", min: 4.5, what: "danger text on page" },
  { fg: "--danger", bg: "--surface", min: 4.5, what: "danger text on panel" },
  { fg: "--warning", bg: "--bg", min: 4.5, what: "warning text on page" },
  { fg: "--success", bg: "--bg", min: 4.5, what: "success text on page" },
  { fg: "--info", bg: "--bg", min: 4.5, what: "info text on page" },
  { fg: "--exam", bg: "--bg", min: 4.5, what: "exam text on page" },
  { fg: "--accent-on", bg: "--accent", min: 4.5, what: "label on filled button" },
  { fg: "--danger-on", bg: "--danger", min: 4.5, what: "label on danger button" },
  { fg: "--lockin-ink", bg: "--lockin-2", min: 4.5, what: "Lock In ink on its ground" },
  // The timer numerals AND the ring stroke both resolve from --phase-focus.
  // This is the exact pair that shipped an invisible Slate timer.
  { fg: "--phase-focus", bg: "--bg", min: 3.0, what: "timer focus phase on page" },
  { fg: "--phase-short", bg: "--bg", min: 3.0, what: "timer short-break phase on page" },
  { fg: "--phase-long", bg: "--bg", min: 3.0, what: "timer long-break phase on page" },
  // A card hairline is not a "UI component boundary" in the 1.4.11 sense —
  // the card is already distinguished by its own ground and shadow, and the
  // border is reinforcement. Reported for visibility, not enforced.
  { fg: "--border2", bg: "--bg", min: 0, what: "strong border on page", info: true },
];

// ── Known pre-existing shortfalls ─────────────────────────────────────────
//
// The free LIGHT theme has shipped since v1.0 and carries two text rows below
// AA. They are recorded here with their measured values rather than fixed,
// for one specific reason: the v1.13 notebook handoff makes "pre-existing
// Light views are pixel-identical to the pre-branch build" an acceptance
// check, with a zero-tolerance screenshot diff. Retuning --muted2 would move
// pixels in every shipped view, which is a different change with a different
// review — not something to smuggle in under a dark-mode branch.
//
// So this list is debt made visible, not an excuse. Rules:
//   - An entry needs the palette, the pair, the measured value and a reason.
//   - `at` is asserted: if the value MOVES, in either direction, the gate
//     fails and the entry has to be revisited. An allowance that silently
//     covers a new, worse value is worse than no gate.
//   - Nothing may be added here for a palette introduced in this milestone.
//     Dark, Black, Stacks and Slate are all new or newly-landed, so they had
//     to meet the bar outright — and they do.
//
// Tracked for a later milestone: raising --muted2 to >=4.5 across the light
// theme, together, with the screenshot diff that change deserves.
const KNOWN = [
  {
    palette: "light", fg: "--muted2", bg: "--bg", at: 4.08,
    why: "shipped since v1.0; light theme is pixel-frozen for the v1.13 notebook diff",
  },
  {
    palette: "light", fg: "--muted2", bg: "--surface", at: 4.30,
    why: "same token, same freeze",
  },
];

function knownFor(palette, check) {
  return KNOWN.find((k) => k.palette === palette && k.fg === check.fg && k.bg === check.bg);
}

let failures = 0;
let rows = 0;
let allowed = 0;
let drifted = 0;

console.log("token contrast — WCAG 2.1, computed from the stylesheets\n");

for (const [name, palette] of Object.entries(PALETTES)) {
  const bad = [];
  const lines = [];

  for (const check of CHECKS) {
    const fg = parseColor(palette[check.fg]);
    const bg = parseColor(palette[check.bg]);

    // A token that is not a literal in this palette (Stacks routes its margin
    // rule through a gutter; Slate sets some to `none`) is not a failure —
    // it is a value this gate cannot see, and saying so is more useful than
    // guessing.
    if (!fg || !bg) {
      lines.push(`    ·     ${check.what} — not a literal in ${name}, skipped`);
      continue;
    }

    rows++;
    const r = ratio(fg, bg);

    if (check.info) {
      lines.push(`   ·  ${r.toFixed(2).padStart(6)}:1  (info)     ${check.what}`);
      continue;
    }

    const known = knownFor(name, check);
    if (known) {
      // Assert the recorded value rather than trusting the entry. A tolerance
      // of 0.01 absorbs rounding, nothing more.
      if (Math.abs(r - known.at) > 0.01) {
        drifted++;
        failures++;
        lines.push(
          `  DRIFT ${r.toFixed(2).padStart(5)}:1  was ${known.at}  ${check.what}` +
          `\n         known-shortfall entry is stale — re-check it, do not just update the number`
        );
      } else {
        allowed++;
        lines.push(`  known ${r.toFixed(2).padStart(5)}:1  (min ${check.min})  ${check.what} — ${known.why}`);
      }
      continue;
    }

    const ok = r >= check.min;
    if (!ok) { bad.push({ ...check, r }); failures++; }
    lines.push(`  ${ok ? "ok " : "FAIL"} ${r.toFixed(2).padStart(6)}:1  (min ${check.min})  ${check.what}`);
  }

  console.log(`── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
  console.log(lines.join("\n"));
  if (bad.length) {
    console.log(`  ${bad.length} failing pair(s) in ${name}`);
  }
  console.log("");
}

console.log(`${rows} pairs measured across ${Object.keys(PALETTES).length} palettes.`);
if (allowed) {
  console.log(`${allowed} known pre-existing shortfall(s) in the light theme, unchanged — see KNOWN.`);
}

if (drifted) {
  console.error(`\n${drifted} known shortfall(s) moved. Re-check the entry rather than editing the number.`);
}
if (failures) {
  console.error(`\n${failures} pair(s) below the required ratio. Fix the token, not the check.`);
  process.exit(1);
}
console.log("Every pair meets its threshold, or is a recorded and unchanged pre-existing shortfall.");
