#!/usr/bin/env node
// Guard against the two ways CJK text entry has broken in this suite.
//
// Run manually:  node scripts/check-ime.mjs
// Run in CI:     npm run check:ime
//
// Why this exists. StudyDesk shipped `android.captureInput: true` from the
// cloud-sync commit through every release up to 1.11.0. That flag swaps the
// WebView's real InputConnection for `BaseInputConnection(view, false)`, which
// does not support composing text — so `setComposingText()`, the mechanism by
// which every IME builds a character, had nowhere to go. Chinese produced
// nothing; English broke too, because Gboard composes for autocorrect.
//
// It survived for months not because it was subtle but because **nobody has
// ever typed CJK into any of the three apps.** A one-line fix does not stop
// that from happening again; a check that fails the build does.
//
// ── Check 1: input-affecting Capacitor flags ────────────────────────────────
// Unambiguous, so it is a hard failure with no escape hatch.
//
// ── Check 2: raw Enter-to-submit handlers ───────────────────────────────────
// A CJK IME uses Enter to commit the candidate selection, so a handler that
// acts on Enter without checking composition steals that keystroke. Every such
// site must route through the shared helper.
//
// Deliberately NOT flagged: `e.key === 'Enter' || e.key === ' '`. That is the
// keyboard-accessibility idiom for a div acting as a button, and an IME never
// composes into a div. Getting this distinction wrong is exactly how the v1.12
// build plan came to claim StudyDesk had 7 such sites when it had 11, NCC 5
// when it had 1, and LimeLog 3 when it had 2.
//
// Escape hatch for a genuine exception: put `ime-ok` in a comment on the same
// line, or within the three lines above it, together with the reason. Use it
// rarely — every waiver is a field a CJK user may not be able to type into.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** Capacitor android options that change how text input reaches the WebView. */
const FORBIDDEN_FLAGS = [
  {
    key: 'captureInput',
    why: 'replaces the WebView InputConnection with a non-full-editor one, ' +
         'which cannot compose text — no IME works, and Gboard autocorrect ' +
         'breaks in English too',
  },
];

const failures = [];

// ── Check 1 ────────────────────────────────────────────────────────────────
// Read the config as text rather than importing it: it is .ts in two of the
// three apps, and a regex over the source catches the flag whether it is set
// literally, spread in, or commented back to life.
for (const name of ['capacitor.config.json', 'capacitor.config.ts', 'capacitor.config.js']) {
  const path = join(ROOT, name);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  for (const { key, why } of FORBIDDEN_FLAGS) {
    // `"captureInput": true` / `captureInput: true` — quoted or not, any spacing.
    const re = new RegExp(`["']?${key}["']?\\s*:\\s*true`);
    if (re.test(text)) {
      failures.push(
        `${name}: \`${key}: true\` is set.\n` +
        `    It ${why}.\n` +
        `    Remove it. The Capacitor default (false) is what every app in the suite should run.`,
      );
    }
  }
}

// ── Check 2 ────────────────────────────────────────────────────────────────
const CODE = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'release']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (CODE.has(extname(entry))) out.push(p);
  }
  return out;
}

// Matches a keydown comparison against Enter in either quote style.
const ENTER = /\.key\s*===?\s*["']Enter["']/;
// The accessibility idiom: Enter OR Space on the same expression.
const ALSO_SPACE = /["'] ["']/;

if (existsSync(SRC)) {
  for (const file of walk(SRC)) {
    // The helper itself necessarily mentions Enter.
    if (/imeSubmit\.(js|ts)$/.test(file)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!ENTER.test(line)) return;
      if (ALSO_SPACE.test(line)) return;                    // div-as-button
      if (/ime-ok/.test(line)) return;                      // same-line waiver
      // A waiver usually needs a sentence of reason, so look back over a short
      // comment block rather than a single line.
      if (lines.slice(Math.max(0, i - 3), i).some((l) => /ime-ok/.test(l))) return;
      // A REAL guard passes on its own merit. Without this the only way to get
      // a correctly-guarded handler past the check was to claim a waiver it
      // did not need, which teaches people to reach for `ime-ok` reflexively
      // and rots the signal. Looks back further than the waiver window because
      // an early-return guard is usually separated from the Enter branch by
      // the comment explaining it.
      if (lines.slice(Math.max(0, i - 8), i).some((l) => /isComposing\s*\(/.test(l))) return;
      failures.push(
        `${file.slice(ROOT.length + 1)}:${i + 1}: Enter handled without an IME composition check.\n` +
        `    ${line.trim().slice(0, 100)}\n` +
        `    Route it through src/lib/imeSubmit — an IME uses Enter to commit its candidate,\n` +
        `    so acting on it here steals the keystroke mid-word.`,
      );
    });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nIME check failed (${failures.length} ${failures.length === 1 ? 'issue' : 'issues'}):\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error('See V1111_HOTFIX_IME.md for why each of these matters.\n');
  process.exitCode = 1;
} else {
  console.log('IME check passed: no input-affecting Capacitor flags, no unguarded Enter handlers.');
}
