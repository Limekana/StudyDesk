// v1.14 Item 8b (#51) — what the "Weight" field on Add Grade actually means.
//
//   > "the weight thing is a bit confusing, I don't know if I should put 0.35
//      for something worth 35% of the grade or what"
//
// The field has always been a MULTIPLICATIVE FACTOR in a weighted mean:
//
//     course grade = Σ(grade × weight) / Σ(weight)
//
// which is correct, scale-free, and means 35 / 30 / 35 and 0.35 / 0.30 / 0.35
// give exactly the same answer. That last property is why the field never
// needed explaining to whoever built it, and exactly why it confuses everyone
// else: a number that can be anything looks like a number that must be
// something particular, and the user cannot tell which.
//
// So: no storage change, no migration, no recomputation of anybody's average.
// `weight` stays the factor. This module is the conversion layer between the
// factor and the three ways people actually think about it:
//
//   factor   35 or 0.35, whatever the user already uses — unchanged behaviour
//   percent  "this is 35% of the course"      -> 0.35
//   points   "this is 10 of 100 course points" -> 0.10
//
// Percent and points both land on the same 0–1 scale, so the two can be mixed
// within a course and still mean what they say. Mixing either with a raw
// factor of 35 does not, which is true today as well — the honest fix for that
// is the share-of-course readout below, which tells the user what a weight is
// actually doing rather than what they meant by it.
//
// The chosen mode is device-local, like the other reading preferences: it
// changes how a number is typed, not what is stored, so it needs no column and
// no sync.

const KEY = 'studydesk-weight-mode';

export const WEIGHT_MODES = ['factor', 'percent', 'points'];

/** The factor. Unchanged for everyone who has not touched this setting, which
 *  matters more here than usual — this control changes how an existing saved
 *  weight is DISPLAYED when reopened, so a different default would silently
 *  rewrite what every stored grade appears to say. */
export const DEFAULT_WEIGHT_MODE = 'factor';

/** The denominator when entering points and the user has not said otherwise. */
export const DEFAULT_POINTS_TOTAL = 100;

export function preferredWeightMode() {
  try {
    const raw = localStorage.getItem(KEY);
    return WEIGHT_MODES.includes(raw) ? raw : DEFAULT_WEIGHT_MODE;
  } catch {
    return DEFAULT_WEIGHT_MODE;
  }
}

export function setPreferredWeightMode(mode) {
  try {
    if (!WEIGHT_MODES.includes(mode) || mode === DEFAULT_WEIGHT_MODE) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* private mode — the choice just won't survive a relaunch */
  }
}

/** Kill floating-point noise without pretending to more precision than the
 *  user typed: 0.35 × 100 is 35.000000000000004, and nobody wants to see it. */
function tidy(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * A typed value, in `mode`, as the factor that gets stored.
 *
 * @returns {number|null} null when the input is not a usable weight — the
 *          caller decides what to do, rather than this quietly returning 1 and
 *          storing a weight the user did not choose.
 */
export function toFactor(mode, value, total = DEFAULT_POINTS_TOTAL) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(n) || n < 0) return null;
  if (mode === 'percent') return tidy(n / 100);
  if (mode === 'points') {
    const t = typeof total === 'string' ? parseFloat(total) : total;
    // A course out of zero points has no shares in it to speak of, and
    // dividing by it would store Infinity into a numeric column.
    if (!Number.isFinite(t) || t <= 0) return null;
    return tidy(n / t);
  }
  return tidy(n);
}

/** The stored factor, shown in `mode`. The inverse of `toFactor`, so reopening
 *  a grade shows the number the user typed rather than a converted one. */
export function fromFactor(mode, factor, total = DEFAULT_POINTS_TOTAL) {
  const f = typeof factor === 'string' ? parseFloat(factor) : factor;
  if (!Number.isFinite(f)) return null;
  if (mode === 'percent') return tidy(f * 100);
  if (mode === 'points') {
    const t = typeof total === 'string' ? parseFloat(total) : total;
    if (!Number.isFinite(t) || t <= 0) return null;
    return tidy(f * t);
  }
  return tidy(f);
}

/**
 * What share of a course one weight actually carries, 0–1.
 *
 * This is the honest answer to the question the Weight field raises, and it is
 * the same answer whatever units the weights were typed in — which is the
 * whole point. A course whose grades are weighted 35 / 30 / 35 and one
 * weighted 0.35 / 0.30 / 0.35 both report 35%.
 *
 * @param {number} weight        the one being asked about
 * @param {number[]} allWeights  every live weight in the course, this one
 *                               included
 * @returns {number|null} null when the course carries no weight at all, where
 *          a share is undefined rather than zero.
 */
export function shareOfCourse(weight, allWeights) {
  const w = Number(weight);
  if (!Number.isFinite(w)) return null;
  let sum = 0;
  for (const x of allWeights || []) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  if (sum <= 0) return null;
  return tidy(w / sum);
}
