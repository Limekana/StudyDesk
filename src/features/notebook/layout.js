// Free placement — where a text box sits on the page.
//
// ── The request ──────────────────────────────────────────────────────────
//
//   > "when typing in the notebook, the text box cant be placed wherever I
//      want but is only a bit to the right from the left edge which is weird,
//      the text boxes should be placeable where I want"
//
// The notebook was a single column pinned at the margin rule. This makes a
// note a page you can put boxes on: tap an empty spot and a box starts there,
// drag it, widen it. Inside a box nothing changes — the same markdown blocks,
// the same checklists, maths and highlight roles, the same one-textarea
// reveal that keeps Android IMEs happy.
//
// ── Why the text is NOT moved out of `content` ────────────────────────────
//
// `notebook_entries.content` is markdown source, one string, and the reasons
// the migration gives for that are still true. More to the point, `P1` says
// old app versions stay in the wild on F-Droid indefinitely, and v1.12/v1.13
// read `content` and nothing else. If the words moved into a layout column,
// every already-shipped version would open these notes EMPTY — the worst
// possible failure for the one kind of data in this app the user cannot
// reconstruct.
//
// So `content` keeps the whole note, in reading order, exactly as before.
// `layout` is an ADDITIVE nullable column that says how to cut that text into
// boxes and where to put them. An old version ignores the column and shows
// the note as one column of text: every word present, only the arrangement
// lost. A new version reads the column and lays the page out.
//
// ── Why each box carries its own text, rather than line offsets ───────────
//
// The obvious encoding is `{from, to}` indices into `content`. It is also
// fragile in exactly the case that matters: an old app version edits the note
// (it can — it has a full editor), `content` shifts by a line, and every
// index after the edit now points at the wrong words. Silent, and it garbles
// the note rather than losing it, which is worse.
//
// Each box holding its own text cannot desynchronise that way. `content` is
// derived FROM the boxes, never parsed back into them, so there is one
// direction of truth. The cost is that a note's text is stored twice — a few
// KB for a long note, against a class of corruption that has no repair path.
//
// The stale case still has to be detected, because an old version CAN rewrite
// `content` under a layout that no longer describes it. `hash` is stored
// alongside the boxes; when it does not match the content we were handed, the
// layout is discarded and the note opens as one box holding whatever the
// other device wrote. Nothing is lost, the arrangement is.

/** The baseline grid, matching `--nb-rule-h`. Vertical positions snap to it so
 *  a box's first line still lands ON a ruling rather than between two. */
export const GRID = 28;

/** Fractions of the page width. A box narrower than this cannot hold a word;
 *  one wider than the page cannot be reached to drag back. */
export const MIN_W = 0.18;
export const MAX_W = 1;

/** A new box is a bit over half the page: wide enough for a sentence, narrow
 *  enough that the next one obviously goes beside it rather than under it. */
export const DEFAULT_W = 0.56;

export const LAYOUT_VERSION = 1;

/** Boxes are joined by a blank line so that a version with no layout reads the
 *  note as separated paragraphs rather than one run-on block. */
const JOIN = '\n\n';

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Snap to the ruling. Exported because the drag handler needs the same
 *  rounding the renderer uses, or a box drifts by a few px per drag. */
export function snapY(y) {
  return Math.max(0, Math.round(y / GRID) * GRID);
}

/**
 * A cheap, stable, order-dependent hash of the note text.
 *
 * FNV-1a. Not a checksum against corruption — it only has to notice that some
 * other version of the app rewrote `content` out from under a layout, and any
 * edit at all changes it. Base 36 so it is short in the JSON.
 */
export function hashContent(text) {
  const s = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // >>> 0 after the multiply keeps this in uint32 range; the shifts are the
    // standard decomposition of the FNV prime for JS number precision.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function newBoxId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID().slice(0, 8);
  } catch { /* insecure context */ }
  return Math.random().toString(36).slice(2, 10);
}

/** Reading order: down the page, then across. The same order a person would
 *  read the boxes in, which is the order `content` has to be in for a version
 *  that cannot see the layout. */
export function readingOrder(boxes) {
  return [...boxes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/** Boxes → the note's `content` string. */
export function joinBoxes(boxes) {
  return readingOrder(boxes)
    .map((b) => String(b.text ?? ''))
    .join(JOIN);
}

/** One box holding the whole note, at the left margin, full width. What a note
 *  written before this feature is, and what a note whose layout went stale
 *  falls back to. */
export function singleBox(content) {
  return [{ id: newBoxId(), x: 0, y: 0, w: MAX_W, text: String(content ?? '') }];
}

export function makeBox({ x, y, w = DEFAULT_W, text = '' }) {
  const nx = clamp(x, 0, 1);
  return {
    id: newBoxId(),
    // Kept on the page: a box dragged so far right that its own width pushes
    // it off screen has no handle left to drag it back by.
    x: clamp(nx, 0, Math.max(0, 1 - MIN_W)),
    y: snapY(y),
    w: clamp(w, MIN_W, MAX_W - Math.min(nx, MAX_W - MIN_W)),
    text: String(text ?? ''),
  };
}

/** Normalise one stored box. Total — anything unusable becomes a usable box
 *  rather than an exception, for the same reason `parse` has no error path. */
function reviveBox(raw, i) {
  const x = clamp(Number(raw?.x), 0, 1 - MIN_W);
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : `b${i}`,
    x,
    y: snapY(Number(raw?.y)),
    w: clamp(Number(raw?.w), MIN_W, MAX_W - x),
    text: typeof raw?.text === 'string' ? raw.text : '',
  };
}

/**
 * The boxes to render for a note.
 *
 * @param {string} content the note's `content` — always the authority on the WORDS
 * @param {object|string|null} layout the stored layout column, if any
 * @returns {{boxes: Array, stale: boolean}} `stale` when a layout existed but
 *   did not describe this content, so the caller can rewrite it rather than
 *   leaving a layout behind that will be discarded again on every open.
 */
export function readLayout(content, layout) {
  let raw = layout;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const boxes = Array.isArray(raw?.boxes) ? raw.boxes : null;
  if (!boxes || boxes.length === 0) {
    // No layout at all is the ordinary case for every note written before
    // this feature, and is not "stale" — there is nothing to rewrite.
    return { boxes: singleBox(content), stale: false };
  }
  const revived = boxes.map(reviveBox);
  const stored = String(raw?.hash ?? '');

  // The layout is only allowed to decide the ARRANGEMENT, so the test that
  // matters is against the CONTENT COLUMN — not against the layout's own
  // boxes, which trivially hash to their own hash and would declare every
  // layout fresh forever. That version of this check passed its own round
  // trip and would have shipped: an older app version's edit to `content`
  // would have been rendered as the layout's stale text and then written back
  // over, losing the edit silently.
  if (hashContent(content) !== stored) {
    return { boxes: singleBox(content), stale: true };
  }
  // And a second time against the boxes, for a layout that is internally
  // inconsistent — a partial write, or a hand-edited row. The content column
  // agrees with the hash but the boxes do not, so the boxes are the wrong one.
  if (hashContent(joinBoxes(revived)) !== stored) {
    return { boxes: singleBox(content), stale: true };
  }
  return { boxes: revived, stale: false };
}

/**
 * Boxes → what to persist.
 *
 * Returns BOTH columns, always together, because they are one fact written in
 * two places: saving the layout without the content it hashes is precisely
 * the stale state this module exists to detect.
 */
export function writeLayout(boxes) {
  const ordered = readingOrder(boxes);
  const content = joinBoxes(ordered);
  return {
    content,
    layout: {
      v: LAYOUT_VERSION,
      hash: hashContent(content),
      boxes: ordered.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, text: b.text })),
    },
  };
}

/**
 * Is this note still a single box at the default position?
 *
 * Used to avoid writing a layout column for notes nobody has arranged — a
 * plain linear note stays exactly the row it was before this feature, which
 * keeps the storage cost and the stale-detection surface at zero for everyone
 * who never drags anything.
 */
export function isUnarranged(boxes) {
  return boxes.length === 1
    && boxes[0].x === 0
    && boxes[0].y === 0
    && boxes[0].w === MAX_W;
}
