import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchShortcut, SHORTCUTS, TYPE_RULES, chord, shortcutFor } from './shortcuts.js';
import { matchBlockRule } from './inputRules.js';
import { BLOCK } from './model.js';

const event = (keys, mac) => ({
  key: keys.key,
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
