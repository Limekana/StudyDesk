// Notebook keyboard shortcuts: what the keys do, and what the app says they
// do, in one file so the two cannot drift (StudyDesk#113: "the shortcuts for
// stuff like bullet points and cursive and bold letters are hidden on the
// desktop version, I don't know what to press").
//
// `matchShortcut` is the behaviour, moved here unchanged from NoteEditor.jsx.
// `SHORTCUTS` is what the format bar's tooltips and the "?" sheet show. The
// test feeds every listed chord through `matchShortcut`, so the sheet can
// never advertise a shortcut that does nothing.

import { BLOCK } from './model.js';
import { MARK } from './inline.js';

// Desktop shortcuts, §5. Word/Docs conventions, unchanged — people arrive
// already knowing these and an app that reassigns them is picking a fight it
// cannot win.
export function matchShortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const k = e.key.toLowerCase();
  if (e.altKey) {
    if (k === '1') return { kind: 'block', type: BLOCK.H1 };
    if (k === '2') return { kind: 'block', type: BLOCK.H2 };
    return null;
  }
  if (e.shiftKey) {
    if (k === 'h') return { kind: 'mark', mark: MARK.HL, role: 1 };
    if (k === '*' || k === '8') return { kind: 'block', type: BLOCK.BULLET };
    if (k === '&' || k === '7') return { kind: 'block', type: BLOCK.NUMBER };
    if (k === '(' || k === '9') return { kind: 'block', type: BLOCK.CHECK };
    if (k === 'p') return { kind: 'photo' };
    if (k === 'm') return { kind: 'span', open: '$', close: '$' };
    if (k === 'e') return { kind: 'span', open: '$$', close: '$$' };
    return null;
  }
  if (k === 'b') return { kind: 'mark', mark: MARK.BOLD };
  if (k === 'i') return { kind: 'mark', mark: MARK.ITALIC };
  if (k === 'u') return { kind: 'mark', mark: MARK.UNDERLINE };
  if (k === '\\') return { kind: 'clear' };
  // ime-ok: this matcher is pure and is only ever reached from NoteEditor's
  // keydown, which returns on `isComposing(e, el)` before calling it. It is
  // also mod-gated — every branch above requires Ctrl/Cmd — so the keystroke
  // is Ctrl+Enter, not the bare Enter an IME commits with.
  if (e.key === 'Enter') return { kind: 'toggleCheck' };
  return null;
}

/** Every shortcut the sheet lists, in the order it lists them. `label` is an
 *  i18n key; `keys` is the chord; `action` is what `matchShortcut` returns for
 *  it (asserted by the test). Photo is left out until photo insertion exists. */
export const SHORTCUTS = [
  { id: 'bold', label: 'nb.bold', keys: { mod: true, key: 'B' }, action: { kind: 'mark', mark: MARK.BOLD } },
  { id: 'italic', label: 'nb.italic', keys: { mod: true, key: 'I' }, action: { kind: 'mark', mark: MARK.ITALIC } },
  { id: 'underline', label: 'nb.underline', keys: { mod: true, key: 'U' }, action: { kind: 'mark', mark: MARK.UNDERLINE } },
  { id: 'highlight', label: 'nb.highlight', keys: { mod: true, shift: true, key: 'H' }, action: { kind: 'mark', mark: MARK.HL, role: 1 } },
  { id: 'h1', label: 'nb.h1', keys: { mod: true, alt: true, key: '1' }, action: { kind: 'block', type: BLOCK.H1 } },
  { id: 'h2', label: 'nb.h2', keys: { mod: true, alt: true, key: '2' }, action: { kind: 'block', type: BLOCK.H2 } },
  { id: 'bullet', label: 'nb.bullet', keys: { mod: true, shift: true, key: '8' }, action: { kind: 'block', type: BLOCK.BULLET } },
  { id: 'numbered', label: 'nb.numbered', keys: { mod: true, shift: true, key: '7' }, action: { kind: 'block', type: BLOCK.NUMBER } },
  { id: 'checklist', label: 'nb.checklist', keys: { mod: true, shift: true, key: '9' }, action: { kind: 'block', type: BLOCK.CHECK } },
  { id: 'toggleCheck', label: 'nb.toggleCheck', keys: { mod: true, key: 'Enter' }, action: { kind: 'toggleCheck' } },
  { id: 'mathInline', label: 'nb.mathInline', keys: { mod: true, shift: true, key: 'M' }, action: { kind: 'span', open: '$', close: '$' } },
  { id: 'mathBlock', label: 'nb.mathBlock', keys: { mod: true, shift: true, key: 'E' }, action: { kind: 'span', open: '$$', close: '$$' } },
  { id: 'clear', label: 'nb.clearFormat', keys: { mod: true, key: '\\' }, action: { kind: 'clear' } },
];

/** The markdown the editor turns into formatting as you type (inputRules.js
 *  for line starts, inline.js for marks). Shown as typed, never translated. */
export const TYPE_RULES = {
  lineStart: [
    ['# ', 'nb.h1'],
    ['## ', 'nb.h2'],
    ['- ', 'nb.bullet'],
    ['1. ', 'nb.numbered'],
    ['[] ', 'nb.checklist'],
  ],
  around: [
    ['**…**', 'nb.bold'],
    ['*…*', 'nb.italic'],
    ['__…__', 'nb.underline'],
    ['==…==', 'nb.highlight'],
    ['$…$', 'nb.mathInline'],
  ],
};

export function isMac() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
}

/** A chord as a person reads it: "Ctrl+Shift+8" or "⌘⇧8". */
export function chord(keys, mac = isMac()) {
  const parts = [];
  if (keys.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (keys.alt) parts.push(mac ? '⌥' : 'Alt');
  if (keys.shift) parts.push(mac ? '⇧' : 'Shift');
  // ime-ok: this only formats the word "Enter" for the help sheet; no key
  // event is read here, so there is no composition to interrupt.
  parts.push(keys.key === 'Enter' ? (mac ? '↩' : 'Enter') : keys.key);
  return parts.join(mac ? '' : '+');
}

/** The chord for one shortcut id, or null. */
export function shortcutFor(id, mac) {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? chord(s.keys, mac) : null;
}
