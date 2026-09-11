// Markdown input rules — the PRIMARY path on mobile (§5).
//
// A phone has no modifier keys, so shortcuts do not exist there. That
// asymmetry is what lets the format bar stay one row at 44px instead of two
// at 88px, which §4 rejects outright. These rules are not a convenience; they
// are the reason the mobile design fits.
//
// Four constraints from §5, all of them load-bearing:
//
//   1. **A rule fires only at the start of an EMPTY block.** `1. ` typed
//      mid-sentence stays literal. Without this, writing "There are 2 cases,
//      1. the trivial one" reformats itself under you.
//   2. **Backspace immediately after a rule fires undoes it** and restores the
//      literal characters. §5: "This is the escape hatch people reach for
//      without being told; without it, input rules feel like a trap." It is
//      the difference between a rule and a hijack.
//   3. **Rules fire on the space or the closing character — never on a timer,
//      never ambiguously.** A rule that fires 300ms after you stop typing is
//      indistinguishable from the app malfunctioning.
//   4. **No auto-correct, no smart quotes, no em-dash substitution.** A maths
//      note types `--`, `"` and `...` deliberately and every one of those
//      "helpful" substitutions destroys it.
//
// Pure and total: takes a block plus what was typed, returns either a
// transformation or null. No DOM, no React, no timers — which is what makes
// the whole set assertable.

import { BLOCK, MAX_INDENT } from './model.js';

// Ordered. `[x] ` must be tried before `[ ] `-style bullets and before the
// bullet rule, for the same reason `**` precedes `*` in the inline rules.
const BLOCK_RULES = [
  { re: /^## $/, type: BLOCK.H2 },
  { re: /^# $/, type: BLOCK.H1 },
  { re: /^\[[xX]\] $/, type: BLOCK.CHECK, checked: true },
  { re: /^\[[ ]?\] $/, type: BLOCK.CHECK, checked: false },
  { re: /^[-*+] $/, type: BLOCK.BULLET },
  { re: /^(\d+)\. $/, type: BLOCK.NUMBER, startFrom: 1 },
];

/**
 * Should typing `text` at `caret` in this block convert it?
 *
 * @param {object} block  the block as it stands AFTER the keystroke
 * @param {number} caret  caret offset within `block.text`
 * @returns {null | {type, checked?, start?, undo: {type, text}}}
 *
 * `undo` carries exactly what to restore if the very next keystroke is
 * Backspace — constraint 2. It records the literal characters consumed, so
 * the restore is a restore and not a re-derivation.
 */
export function matchBlockRule(block, caret) {
  // Only at the start of an otherwise-empty block. `caret === text.length`
  // means the trigger is the last thing typed rather than something pasted
  // into the middle.
  if (!block || block.type !== BLOCK.P) return null;
  if (caret !== block.text.length) return null;

  for (const rule of BLOCK_RULES) {
    const m = rule.re.exec(block.text);
    if (!m) continue;
    return {
      type: rule.type,
      checked: rule.checked ?? false,
      start: rule.startFrom ? Number(m[rule.startFrom]) : undefined,
      undo: { type: BLOCK.P, text: block.text },
    };
  }
  return null;
}

/**
 * Apply a matched rule: the block changes type and its text empties, because
 * the trigger characters BECOME the marker rather than staying as content.
 */
export function applyBlockRule(block, match) {
  return {
    ...block,
    type: match.type,
    checked: match.checked,
    ...(match.start !== undefined ? { start: match.start } : {}),
    text: '',
  };
}

/** Restore the literal characters. Constraint 2, and nothing more than it. */
export function undoBlockRule(block, undo) {
  return { ...block, type: undo.type, checked: false, start: undefined, text: undo.text };
}

// ── Enter / Tab / Backspace, the structural keys ──────────────────────────

const LIST_TYPES = new Set([BLOCK.BULLET, BLOCK.NUMBER, BLOCK.CHECK]);

export function isList(type) {
  return LIST_TYPES.has(type);
}

/**
 * What Enter does at the end of `block`.
 *
 * `exit` on an empty list item is the standard way out of a list and the only
 * one people try. Without it the only escape is Backspace-until-it-stops
 * being a list, which reads as the app refusing to let go.
 *
 * A heading never continues: pressing Enter after a heading starts body text,
 * because two consecutive H1s is not a thing anyone means to type.
 */
export function enterBehaviour(block) {
  if (isList(block.type) && !block.text.trim()) {
    // Outdent first if nested, only exit from the outer level. Matches every
    // list implementation people have used, and means one Enter is never a
    // surprise two-level jump.
    if ((block.indent || 0) > 0) return { action: 'outdent' };
    return { action: 'exit' };
  }
  if (block.type === BLOCK.H1 || block.type === BLOCK.H2) {
    return { action: 'new', type: BLOCK.P, indent: 0 };
  }
  if (isList(block.type)) {
    // A new checklist item starts UNCHECKED regardless of the one above it —
    // inheriting `checked` would silently mark work done that nobody did.
    return { action: 'new', type: block.type, indent: block.indent || 0, checked: false };
  }
  return { action: 'new', type: BLOCK.P, indent: block.indent || 0 };
}

/**
 * Tab / Shift+Tab. Capped at two levels total (§5), matching the tree
 * diagram's own limit — one nesting rule for the whole feature.
 *
 * Only inside a list. Tab in a paragraph inserts nothing: an indented
 * paragraph is a layout tool, and this is a study notebook.
 */
export function indentBehaviour(block, shift) {
  if (!isList(block.type)) return null;
  const cur = block.indent || 0;
  const next = shift ? cur - 1 : cur + 1;
  if (next < 0 || next > MAX_INDENT) return null;
  return { ...block, indent: next };
}

/**
 * Backspace at offset 0.
 *
 * A list item first loses its nesting, then its type, and only then merges
 * with the block above. Three presses to destroy a line rather than one, and
 * each press does something visible — so nobody loses a line to a Backspace
 * they meant as an outdent.
 */
export function backspaceAtStart(block) {
  if (isList(block.type) && (block.indent || 0) > 0) {
    return { action: 'outdent', block: { ...block, indent: block.indent - 1 } };
  }
  if (block.type !== BLOCK.P) {
    return { action: 'plain', block: { ...block, type: BLOCK.P, checked: false, start: undefined } };
  }
  return { action: 'merge' };
}
