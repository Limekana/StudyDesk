import { describe, it, expect } from 'vitest';
import {
  readLayout, writeLayout, singleBox, isUnarranged, pageHeight, moveTo, resizeTo, settle,
  placeNewBox, MAX_W, MIN_W, GRID, TRAILING_ROWS, DEFAULT_W, COMFY_PX,
} from './layout.js';

describe('a press that barely moved leaves a note unarranged (StudyDesk issue 131, P1)', () => {
  const full = { x: 0, y: 0, w: MAX_W };
  it('a 2px jitter on a full-width box settles back to exactly x 0, w 1, y 0', () => {
    const r = settle(moveTo(full, 0.004, 5));
    expect(r).toEqual({ x: 0, y: 0, w: MAX_W });
    expect(isUnarranged([{ ...r, id: 'b0', text: '' }])).toBe(true);
  });
  it('a real move is kept', () => {
    const r = settle(moveTo(full, 0.2, 60));
    expect(r.x).toBeCloseTo(0.2);
    expect(r.w).toBeCloseTo(0.8);
    expect(r.y).toBe(56);
  });
  it('a box let go just short of the right edge reaches it', () => {
    expect(settle({ x: 0.5, y: 0, w: 0.49 }).w).toBeCloseTo(0.5);
    expect(settle({ x: 0.5, y: 0, w: 0.4 }).w).toBeCloseTo(0.4);
  });
});

describe('starting a box with a tap (StudyDesk issue 114)', () => {
  it('the tap is the top-left when the default width fits there', () => {
    expect(placeNewBox(0.2, 515)).toEqual({ x: 0.2, w: DEFAULT_W });
  });
  it('with less room it narrows, but only down to a comfortable width', () => {
    const r = placeNewBox(0.5, 515);
    expect(r.x).toBeCloseTo(0.5);
    expect(r.w).toBeCloseTo(0.5);
  });
  it('near the right edge it moves left instead of becoming a sliver', () => {
    // The reported case: a tap at 80% of a 515px page gave a box 77px wide.
    const r = placeNewBox(0.8, 515);
    expect(r.w * 515).toBeGreaterThanOrEqual(COMFY_PX - 0.001);
    expect(r.x + r.w).toBeCloseTo(MAX_W);
  });
  it('on a phone-width page a new box always gets the default width', () => {
    const r = placeNewBox(0.9, 322);
    expect(r.w).toBeCloseTo(DEFAULT_W);
    expect(r.x).toBeCloseTo(MAX_W - DEFAULT_W);
  });
  it('never off the page, never narrower than MIN_W, whatever it is given', () => {
    for (const [fx, px] of [[-1, 500], [2, 500], [NaN, 500], [0.5, 0], [0.99, 5000]]) {
      const r = placeNewBox(fx, px);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.w).toBeGreaterThanOrEqual(MIN_W);
      expect(r.x + r.w).toBeLessThanOrEqual(MAX_W + 1e-9);
    }
  });
});

describe('moving a box (StudyDesk issue 112)', () => {
  const full = { x: 0, y: 0, w: MAX_W };
  it('a full-width box can be dragged sideways: it narrows against the page edge', () => {
    // The bug: x was clamped to 1 - w, so a full-width box could not move at all.
    const r = moveTo(full, 0.3, 0);
    expect(r.x).toBeCloseTo(0.3);
    expect(r.w).toBeCloseTo(0.7);
  });
  it('never narrower than MIN_W, never off the page', () => {
    const r = moveTo(full, 5, 0);
    expect(r.x).toBeCloseTo(1 - MIN_W);
    expect(r.w).toBeCloseTo(MIN_W);
    expect(moveTo(full, -5, 0).x).toBe(0);
  });
  it('pulled back in the same drag, it gets its width back', () => {
    expect(moveTo(full, 0.3, 0).w).toBeCloseTo(0.7);
    expect(moveTo(full, 0.1, 0).w).toBeCloseTo(0.9);
    expect(moveTo(full, 0, 0).w).toBe(MAX_W);
  });
  it('a box that fits keeps its width', () => {
    const r = moveTo({ x: 0.1, y: 0, w: 0.4 }, 0.2, 0);
    expect(r.x).toBeCloseTo(0.3);
    expect(r.w).toBeCloseTo(0.4);
  });
  it('follows the pointer vertically during the drag: no 28px steps', () => {
    // The bug: every move snapped, so the box jumped a rule at a time.
    expect(moveTo(full, 0, 13).y).toBe(13);
    expect(moveTo(full, 0, 41).y).toBe(41);
    expect(moveTo({ ...full, y: 56 }, 0, -500).y).toBe(0);
  });
  it('settles onto the ruling on release', () => {
    expect(settle({ x: 0.2, y: 13, w: 0.5 })).toEqual({ x: 0.2, y: 0, w: 0.5 });
    expect(settle({ x: 0.2, y: 15, w: 0.5 })).toEqual({ x: 0.2, y: GRID, w: 0.5 });
    expect(settle({ x: 0.2, y: 60, w: 0.5 }).y).toBe(2 * GRID);
  });
  it('resizing keeps the left edge and stays on the page', () => {
    expect(resizeTo({ x: 0.5, y: 0, w: 0.3 }, 0.4).w).toBeCloseTo(0.5);
    expect(resizeTo({ x: 0.5, y: 0, w: 0.3 }, -1).w).toBeCloseTo(MIN_W);
  });
});

describe('pageHeight (StudyDesk issue 111)', () => {
  const T = TRAILING_ROWS * GRID;
  it('counts from the lowest box BOTTOM, not its top', () => {
    // The bug: a 30-line box at y=0 left a 168px page and hung 700px past it.
    expect(pageHeight([{ id: 'a', y: 0 }], { a: 868 }, { trailing: T })).toBe(868 + T);
  });
  it('the lowest box is the one that ends lowest, not the one that starts lowest', () => {
    const boxes = [{ id: 'tall', y: 0 }, { id: 'short', y: 280 }];
    expect(pageHeight(boxes, { tall: 900, short: 28 }, { trailing: 100 })).toBe(1000);
  });
  it('a box not measured yet still counts as one rule', () => {
    expect(pageHeight([{ id: 'a', y: 56 }], {}, { trailing: 0 })).toBe(56 + GRID);
  });
  it('never less than the visible paper', () => {
    expect(pageHeight([{ id: 'a', y: 0 }], { a: 28 }, { trailing: 100, fill: 700 })).toBe(700);
  });
  it('an empty page is just the trailing room', () => {
    expect(pageHeight([], {}, { trailing: T })).toBe(T);
  });
});

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
