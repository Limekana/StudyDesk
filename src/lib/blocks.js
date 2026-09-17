// v1.14 — the "concrete metaphor" visual language, carried over from LimeLog.
//
// LimeLog draws a barbell weight as an actual loaded bar: plate diameter and
// thickness are true to the inventory, so 145 kg and 100 kg are visibly
// different objects rather than two different numbers. The move is to turn a
// number the user has to TRUST into an object they can CHECK.
//
// Two numbers in StudyDesk ask for the same treatment, and this module is the
// arithmetic behind both, kept out of the components so it can be asserted.
//
// ── THE RULE THAT MAKES THE PICTURE HONEST ───────────────────────────────
//
// A proportional bar lies by omission the moment a real value renders at zero
// pixels: a grade worth 1% of a course is not nothing, and a row of blocks
// that silently drops it tells the student they have three assessments when
// they have four. So `MIN_SEGMENT` gives every live value a floor, and the
// distortion that introduces is paid for by `share` — the true fraction —
// riding along on every segment so the component can always print the number
// as text beside the picture.
//
// That is the same contract LimeLog's `PlateBar` holds itself to: the bay is
// never the only representation of the weight.

/** Percentage-point floor for a segment that exists at all. Below about this
 *  a block stops reading as a block and starts reading as a border. */
export const MIN_SEGMENT = 1.5;

/** How many punches to draw before collapsing the rest into a count. A school
 *  year runs to a few hundred lessons; past roughly this many the row stops
 *  being a pattern anyone can read and becomes texture. */
export const PUNCH_CAP = 120;

function finite(n) {
  const x = typeof n === 'string' ? parseFloat(n) : n;
  return Number.isFinite(x) ? x : null;
}

/**
 * A course's weight budget as a row of segments, in the order given.
 *
 * @param {Array<{id?: *, weight: number}>} items every live grade in the course
 * @param {*} activeId  the one being asked about, or null
 * @returns {{segments: Array, total: number}} `segments` carry:
 *            `share`   the TRUE fraction 0–1, for the text readout
 *            `width`   the fraction to draw, floored and renormalised
 *            `active`  whether this is the one in question
 *
 * Returns no segments when the course carries no weight at all — a share is
 * undefined there rather than zero, and drawing an empty rail would imply the
 * grades exist but count for nothing, which is a different claim.
 */
export function weightSegments(items, activeId = null) {
  const live = [];
  let total = 0;
  for (const it of items || []) {
    const w = finite(it?.weight);
    if (w === null || w <= 0) continue;
    live.push({ id: it.id, weight: w });
    total += w;
  }
  if (total <= 0 || live.length === 0) return { segments: [], total: 0 };

  const floor = MIN_SEGMENT / 100;
  // Floor first, then renormalise, so the drawn widths still sum to 1 and the
  // rail has no gap at the end. Without the second pass a row of many tiny
  // segments would overflow its track.
  const floored = live.map((x) => Math.max(x.weight / total, floor));
  const drawnTotal = floored.reduce((a, b) => a + b, 0);

  return {
    total,
    segments: live.map((x, i) => ({
      id: x.id,
      weight: x.weight,
      share: x.weight / total,
      width: floored[i] / drawnTotal,
      active: activeId !== null && activeId !== undefined && x.id === activeId,
    })),
  };
}

/**
 * Attendance rows as a punch card: one mark per lesson, oldest first.
 *
 * Date order, not status order — the point of a punch card over a percentage
 * is that it shows WHEN. "I was fine until March" is invisible in a single
 * figure and obvious in a row of marks.
 *
 * Newest are kept when the cap bites, because a student asking about
 * attendance is asking about now.
 *
 * @returns {{punches: Array<{date, status}>, hidden: number}}
 */
export function punchRow(rows, cap = PUNCH_CAP) {
  const live = (rows || [])
    .filter((r) => r && !r.deletedAt && r.status && r.date)
    .map((r) => ({ date: String(r.date), status: r.status }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : live.length;
  if (live.length <= limit) return { punches: live, hidden: 0 };
  return { punches: live.slice(live.length - limit), hidden: live.length - limit };
}
