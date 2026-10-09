import { describe, it, expect } from 'vitest';
import { readLayout, writeLayout, singleBox, isUnarranged, MAX_W } from './layout.js';

describe('readLayout: box identity', () => {
  // NotebookView re-derives the boxes from `content` on every change, and
  // NoteCanvas keys each box's editor by its id. A note nobody has arranged
  // stores no layout, so it goes through singleBox() every time: a fresh random
  // id there remounted the editor on every committed line, and Enter dropped
  // the caret (v1.18, found while measuring StudyDesk#112).
  it('gives an unarranged note the same box id on every read', () => {
    const a = readLayout('first line', null).boxes;
    const b = readLayout('first line\n\nsecond line', null).boxes;
    expect(a).toHaveLength(1);
    expect(b[0].id).toBe(a[0].id);
  });

  it('keeps that id through a write that stays unarranged', () => {
    const [box] = readLayout('one', null).boxes;
    const { content, layout } = writeLayout([{ ...box, text: 'one\n\ntwo' }]);
    expect(isUnarranged([{ ...box }])).toBe(true);
    // An unarranged note is stored with no layout, so the next read is again
    // singleBox(); the id it hands back must be the one the editor is keyed by.
    expect(readLayout(content, null).boxes[0].id).toBe(box.id);
    expect(layout.boxes[0].id).toBe(box.id);
  });

  it('a stale layout falls back to the same stable single box', () => {
    const stale = { v: 1, hash: 'nope', boxes: [{ id: 'x1', x: 0.3, y: 56, w: 0.4, text: 'old' }] };
    const r1 = readLayout('new words', stale);
    const r2 = readLayout('new words', stale);
    expect(r1.stale).toBe(true);
    expect(r1.boxes[0].id).toBe(r2.boxes[0].id);
    expect(r1.boxes[0]).toMatchObject({ x: 0, y: 0, w: MAX_W, text: 'new words' });
  });

  it('an arranged note keeps its stored ids', () => {
    const { content, layout } = writeLayout([
      { id: 'aa', x: 0, y: 0, w: 0.5, text: 'left' },
      { id: 'bb', x: 0.5, y: 0, w: 0.5, text: 'right' },
    ]);
    expect(readLayout(content, layout).boxes.map((b) => b.id)).toEqual(['aa', 'bb']);
  });

  it('singleBox is stable on its own', () => {
    expect(singleBox('a')[0].id).toBe(singleBox('b')[0].id);
  });
});
