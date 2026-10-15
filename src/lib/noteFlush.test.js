import { describe, it, expect, vi, beforeAll } from 'vitest';
import { FLUSH_NOTE_EDITS_EVENT, requestNoteFlush, otherAccountClearedMessage } from './noteFlush.js';

// v1.18.1 (StudyDesk#161) — sign-out counted only queued changes, so a note
// edit inside its 1.5 s debounce was not counted; and a switch to another
// account cleared the previous one's data with only a console line.

describe('requestNoteFlush', () => {
  it('fires the event the note sync listens for, synchronously', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('CustomEvent', class extends Event {});
    try {
      let flushed = 0;
      target.addEventListener(FLUSH_NOTE_EDITS_EVENT, () => { flushed += 1; });
      requestNoteFlush();
      expect(flushed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is harmless with no window', () => {
    expect(() => requestNoteFlush()).not.toThrow();
  });
});

describe('otherAccountClearedMessage', () => {
  let t;
  beforeAll(async () => {
    const { default: i18n, i18nReady } = await import('../i18n');
    await i18nReady;
    t = i18n.t.bind(i18n);
  });

  it('names the unsent changes when there were any', () => {
    expect(otherAccountClearedMessage(t, 3)).toMatch(/3 changes that had not synced/);
    expect(otherAccountClearedMessage(t, 1)).toMatch(/1 change that had not synced/);
    expect(otherAccountClearedMessage(t, 0)).not.toMatch(/had not synced/);
  });
});
