import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchShortcut, SHORTCUTS, TYPE_RULES, chord, shortcutFor } from './shortcuts.js';
import { matchBlockRule } from './inputRules.js';
import { BLOCK } from './model.js';

const event = (keys, mac) => ({
  key: keys.key,
  code: /^[0-9]$/.test(keys.key) ? `Digit${keys.key}` : undefined,
  metaKey: !!keys.mod && mac,
  ctrlKey: !!keys.mod && !mac,
  shiftKey: !!keys.shift,
  altKey: !!keys.alt,
});

describe('the shortcut sheet tells the truth (StudyDesk issue 113)', () => {
  it('every listed chord does what the sheet says, with Ctrl and with Cmd', () => {
    for (const s of SHORTCUTS) {
      expect(matchShortcut(event(s.keys, false)), `${s.id} (Ctrl)`).toEqual(s.action);
      expect(matchShortcut(event(s.keys, true)), `${s.id} (Cmd)`).toEqual(s.action);
    }
  });

  it('Shift+8/7/9 also work when the layout reports the shifted symbol', () => {
    expect(matchShortcut({ key: '*', ctrlKey: true, shiftKey: true })).toEqual({ kind: 'block', type: BLOCK.BULLET });
    expect(matchShortcut({ key: '&', ctrlKey: true, shiftKey: true })).toEqual({ kind: 'block', type: BLOCK.NUMBER });
    expect(matchShortcut({ key: '(', ctrlKey: true, shiftKey: true })).toEqual({ kind: 'block', type: BLOCK.CHECK });
  });

  it('number-row chords go by key position, whatever the layout types (issue 130)', () => {
    // Finnish/German/Spanish: Shift+8 is "(", Shift+7 is "/", Shift+9 is ")".
    const fi = (key, code) => ({ key, code, ctrlKey: true, shiftKey: true });
    expect(matchShortcut(fi('(', 'Digit8'))).toEqual({ kind: 'block', type: BLOCK.BULLET });
    expect(matchShortcut(fi('/', 'Digit7'))).toEqual({ kind: 'block', type: BLOCK.NUMBER });
    expect(matchShortcut(fi(')', 'Digit9'))).toEqual({ kind: 'block', type: BLOCK.CHECK });
    // US: Shift+9 is "(" on Digit9, still the checklist.
    expect(matchShortcut(fi('(', 'Digit9'))).toEqual({ kind: 'block', type: BLOCK.CHECK });
    // Mac Option+1 / Option+2 type "¡" / "™".
    expect(matchShortcut({ key: '¡', code: 'Digit1', metaKey: true, altKey: true })).toEqual({ kind: 'block', type: BLOCK.H1 });
    expect(matchShortcut({ key: '™', code: 'Digit2', metaKey: true, altKey: true })).toEqual({ kind: 'block', type: BLOCK.H2 });
  });

  it('AltGr is typing, not a chord: AltGr+2 is "@" on a Finnish keyboard', () => {
    const altGr = (key, code) => ({
      key, code, ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph',
    });
    expect(matchShortcut(altGr('@', 'Digit2'))).toBeNull();
    expect(matchShortcut(altGr('|', 'Digit1'))).toBeNull();
    // Without AltGr, Ctrl+Alt+2 is still H2.
    expect(matchShortcut({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true, getModifierState: () => false }))
      .toEqual({ kind: 'block', type: BLOCK.H2 });
  });

  it('$$…$$ is listed as chemistry, because that is what it renders as', () => {
    expect(SHORTCUTS.find((s) => s.action.open === '$$').label).toBe('nb.chemEquation');
    expect(TYPE_RULES.around.find(([typed]) => typed === '$$…$$')[1]).toBe('nb.chemEquation');
  });

  it('every line-start rule the sheet lists really converts a line', () => {
    for (const [typed] of TYPE_RULES.lineStart) {
      const block = { type: BLOCK.P, text: typed, indent: 0 };
      expect(matchBlockRule(block, typed.length), JSON.stringify(typed)).not.toBeNull();
    }
  });

  it('every label it uses exists in English', () => {
    const en = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../i18n/locales/en.json'), 'utf8'));
    const keys = [...SHORTCUTS.map((s) => s.label), ...TYPE_RULES.lineStart.map((r) => r[1]), ...TYPE_RULES.around.map((r) => r[1])];
    for (const k of keys) {
      const v = k.split('.').reduce((n, p) => (n ? n[p] : undefined), en);
      expect(typeof v, k).toBe('string');
    }
  });
});

describe('chord', () => {
  it('reads like the platform', () => {
    expect(chord({ mod: true, shift: true, key: '8' }, false)).toBe('Ctrl+Shift+8');
    expect(chord({ mod: true, shift: true, key: '8' }, true)).toBe('⌘⇧8');
    expect(chord({ mod: true, alt: true, key: '1' }, false)).toBe('Ctrl+Alt+1');
    expect(chord({ mod: true, key: 'Enter' }, true)).toBe('⌘↩');
    expect(shortcutFor('bold', false)).toBe('Ctrl+B');
    expect(shortcutFor('nope', false)).toBeNull();
  });
});
