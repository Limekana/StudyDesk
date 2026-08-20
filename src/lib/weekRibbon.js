// Phone week ribbon — days as ROWS, time as the horizontal axis.
//
// Why this exists rather than reusing the desktop week grid: that grid is
// days-as-columns, and at 360px CSS forced it into a 620px min-width box that
// scrolled sideways. About three and a half days were on screen at once, which
// defeats the only thing the feature is for — the owner's framing was seeing
// that "Tuesday evening is already gone" BEFORE planning to revise in it, and
// you cannot answer "is my week full?" by scrolling. By the time Friday is
// visible, Monday is a memory.
//
// Rotating the axes is what makes seven days fit. The trade is real and
// deliberate: a day gets ~14px per hour of width instead of ~44px per hour of
// height, so the ribbon shows a week's SHAPE and the day agenda carries the
// detail. Reading is a tap away; the glance is not.

/** Fallback window when a week holds nothing at all. Not 00:00–24:00: an empty
 *  week rendered against a full day squashes the hours anyone actually uses
 *  into the middle third. */
export const RIBBON_FALLBACK = { from: 8 * 60, to: 20 * 60 };

/** A week whose content spans less than this still renders against this many
 *  hours. Without it, a week holding one 60-minute block would compute a
 *  60-minute window and draw that block edge to edge — technically correct,
 *  and a lie about how full the day is. */
export const RIBBON_MIN_SPAN_MIN = 8 * 60;

const DAY = 24 * 60;
const clampDay = (m) => Math.max(0, Math.min(DAY, m));

/** End minute of an item, whichever way it happens to carry its length.
 *  Lessons come from `timetable.js` with an explicit `endMin`; sessions and
 *  planned blocks come from `calendar.js` with `durationMinutes`. A block with
 *  neither is treated as a 15-minute sliver rather than dropped — it exists,
 *  and drawing nothing would hide a real entry. */
export function endOf(item) {
  if (!item) return 0;
  if (Number.isFinite(item.endMin)) return clampDay(item.endMin);
  const dur = Number.isFinite(item.durationMinutes) ? item.durationMinutes : 15;
  return clampDay((item.startMin || 0) + Math.max(15, dur));
}

const startOf = (item) => clampDay(item?.startMin || 0);

/**
 * ONE time window shared by all seven rows.
 *
 * This is the load-bearing decision in the whole view. Fitting each row to its
 * own content is tempting and wrong: a single one-hour block on an empty
 * Sunday would then render exactly as wide as a packed Tuesday, and the
 * week-at-a-glance comparison — the entire point — would be a lie told
 * convincingly. Every row therefore shares one scale, so width means the same
 * thing on every line.
 *
 * Padded out to whole hours so the axis labels land on the hours they name.
 */
export function ribbonWindow(allItems, fallback = RIBBON_FALLBACK, until = null) {
  // `until` is the owner's "latest I want to study" setting, in minutes past
  // midnight. It only ever EXTENDS the window — a lesson that runs to 22:00
  // still gets drawn on a day whose ceiling is 21:00, because hiding a real
  // commitment to honour a preference is the worse of the two failures.
  const ceiling = Number.isFinite(until) ? clampDay(until) : null;

  const items = (allItems || []).filter((it) => it && Number.isFinite(it.startMin));
  if (!items.length) {
    const base = { ...fallback };
    return ceiling !== null && ceiling > base.to ? { ...base, to: ceiling } : base;
  }

  let from = Infinity;
  let to = -Infinity;
  for (const it of items) {
    from = Math.min(from, startOf(it));
    to = Math.max(to, endOf(it));
  }
  // Applied BEFORE the whole-hour rounding and the minimum-span growth, so an
  // evening ceiling participates in both rather than being bolted on after and
  // fighting them.
  if (ceiling !== null) to = Math.max(to, ceiling);
  // Whole hours outward, never inward — flooring the start and ceiling the end
  // guarantees no block is clipped by its own window.
  from = Math.floor(from / 60) * 60;
  to = Math.ceil(to / 60) * 60;

  if (to - from < RIBBON_MIN_SPAN_MIN) {
    // Grow around the midpoint so a short day stays centred rather than being
    // shoved against one edge, then push back inside the day if that overflows.
    const mid = (from + to) / 2;
    from = Math.floor((mid - RIBBON_MIN_SPAN_MIN / 2) / 60) * 60;
    to = from + RIBBON_MIN_SPAN_MIN;
    if (from < 0) { from = 0; to = RIBBON_MIN_SPAN_MIN; }
    if (to > DAY) { to = DAY; from = DAY - RIBBON_MIN_SPAN_MIN; }
  }
  return { from: clampDay(from), to: clampDay(to) };
}

/** Position of a minute within the window, as a 0–100 percentage.
 *  Clamped: a block starting before the window (it cannot, given how the
 *  window is derived, but data changes underneath renders) must not draw at a
 *  negative offset and escape its row. */
export function pctIn(minute, win) {
  const span = Math.max(1, win.to - win.from);
  return Math.max(0, Math.min(100, ((minute - win.from) / span) * 100));
}

/** Left/width percentages for one item. Width has a floor so a 10-minute
 *  block is still tappable rather than a hairline. */
export function spanPct(item, win, minWidthPct = 2.5) {
  const left = pctIn(startOf(item), win);
  const right = pctIn(endOf(item), win);
  return { left, width: Math.max(minWidthPct, right - left) };
}

/**
 * Stack overlapping items into lanes within one day row.
 *
 * Greedy first-fit over items sorted by start. Lessons are pinned to lane 0
 * regardless: they are the day's skeleton, drawn as a background band, and
 * letting a training session push the school day onto a second line would
 * invert which one reads as context.
 */
export function packRibbon(items) {
  const list = (items || [])
    .filter((it) => it && Number.isFinite(it.startMin))
    .slice()
    .sort((a, b) => startOf(a) - startOf(b) || endOf(a) - endOf(b));

  // Lane 0 belongs to lessons only on days that HAVE one. Reserving it
  // unconditionally was a real defect: on a lesson-free day (a weekend, a
  // holiday, any evening plan on a day off) every block was pushed to lane 1
  // and drew below an empty band, which is exactly the "too small and off
  // centred" the owner reported — the block was the right size, it was sitting
  // in the second of two lanes with nothing in the first.
  const firstFree = list.some((it) => it.kind === 'lesson') ? 1 : 0;

  const laneEnds = [0];
  const out = [];
  for (const it of list) {
    if (it.kind === 'lesson') { out.push({ item: it, lane: 0 }); continue; }
    const s = startOf(it);
    let lane = -1;
    for (let i = firstFree; i < laneEnds.length; i++) {
      if (laneEnds[i] <= s) { lane = i; break; }
    }
    if (lane === -1) lane = Math.max(firstFree, laneEnds.length);
    laneEnds[lane] = endOf(it);
    out.push({ item: it, lane });
  }
  const lanes = out.reduce((m, o) => Math.max(m, o.lane + 1), 1);
  return { placed: out, lanes };
}

/** Merged busy stretches, clipped to the window. Shared by the load figures
 *  and by the agenda's free-gap list so the two can never disagree about what
 *  "free" means. */
export function busyRuns(items, win) {
  const runs = (items || [])
    .filter((it) => it && Number.isFinite(it.startMin))
    .map((it) => ({ from: Math.max(win.from, startOf(it)), to: Math.min(win.to, endOf(it)) }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from);

  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

/** Committed vs free minutes inside the window for one day. */
export function dayLoad(items, win) {
  const busy = busyRuns(items, win).reduce((sum, r) => sum + (r.to - r.from), 0);
  const span = Math.max(0, win.to - win.from);
  return { busyMin: busy, freeMin: Math.max(0, span - busy) };
}

/**
 * The week's headline figures.
 *
 * `planned` and `logged` are counted from the items themselves rather than
 * being folded into `busy`, because they answer a different question. Busy is
 * "what is spoken for"; planned is "what I have promised myself"; logged is
 * "what I actually did". A planned block IS busy — it occupies the hour — so
 * it is in both, on purpose.
 */
export function weekLoad(daysItems, win) {
  let freeMin = 0;
  let plannedMin = 0;
  let loggedMin = 0;
  for (const items of daysItems) {
    freeMin += dayLoad(items, win).freeMin;
    for (const it of items || []) {
      const len = Math.max(0, endOf(it) - startOf(it));
      if (it.kind === 'planned') plannedMin += len;
      else if (it.kind === 'session') loggedMin += len;
    }
  }
  return { freeMin, plannedMin, loggedMin };
}

/** Free stretches worth offering as a plan target. `minGap` exists because a
 *  12-minute hole between two lessons is not study time in any useful sense,
 *  and listing it as one would be noise on the smallest screen in the suite. */
export function freeSlots(items, win, minGap = 30) {
  const busy = busyRuns(items, win);
  const gaps = [];
  let cursor = win.from;
  for (const r of busy) {
    if (r.from > cursor) gaps.push({ from: cursor, to: r.from });
    cursor = Math.max(cursor, r.to);
  }
  if (cursor < win.to) gaps.push({ from: cursor, to: win.to });
  return gaps.filter((g) => g.to - g.from >= minGap);
}
