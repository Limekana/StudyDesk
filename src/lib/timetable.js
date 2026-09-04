// Academic terms and the weekly timetable that hangs off them.
//
// The owner's model, in their words: "School Year is the top one like this
// upcoming 26/27 year then it has in finland at least two semesters, I know in
// britain and elsewhere in europe there can be three semesters, and then under
// a semester are the Jaksot […] this means that a schedule can be made for
// either a Jakso or then if there are no jaksot/they do not differ in schedule
// from each other one can make the schedule go over the entire semester or
// even school year if they want to."
//
// That last clause is the whole design constraint. A schedule must be able to
// attach at ANY level, which is why `academic_terms` is one self-referencing
// table rather than three tables — three would need three nullable foreign keys
// on `timetable_entries` plus a rule for which one wins, and the rule would
// still have to be written. Here it is written once, below, as SPECIFICITY.
//
// Nothing in this file writes a lesson into `study_sessions`, and nothing ever
// should. Attending a lesson is not self-directed study; merging the two would
// inflate every study statistic in StudyDesk and, because NCC derives its Life
// Score from that same table, silently inflate NCC's too.

import { parseLocalDate, toLocalISO } from './dates.js';

export const TERM_LEVELS = ['year', 'semester', 'period'];

/** Deeper level = more specific. Used for both nesting rules and override. */
const LEVEL_RANK = { year: 0, semester: 1, period: 2 };

export function levelRank(level) {
  return LEVEL_RANK[level] ?? -1;
}

/** The level a child of `level` must be, or null if `level` cannot nest. */
export function childLevel(level) {
  if (level === 'year') return 'semester';
  if (level === 'semester') return 'period';
  return null;
}

// ── Alternating weeks (v1.13 Tier 2) ───────────────────────────────────────
//
// Reported 2026-09-02, rated 5/5: "I have classes every two weeks but I didn't
// find a way to make it happen in timetable here." Standard in European
// timetables, including the jakso system this app was built around.
//
// `weekParity` on a timetable entry is `null` (every week), 1 (odd weeks) or
// 2 (even weeks). Nullable and additive, per `P1` — an app version that
// predates this column reads the row and shows the lesson every week, which
// is the correct degradation: a user on an old build sees too many lessons,
// never too few.
//
// ── What week 1 is, and why it is not the ISO week number ────────────────
//
// The parity is counted from THE START OF THE TERM THE ENTRY BELONGS TO, not
// from January and not from the ISO week number. Three reasons, and the third
// is decisive:
//
//   1. A student says "week A / week B" relative to their timetable, which
//      starts when the term starts. Nobody thinks in ISO week 37.
//   2. ISO week numbers roll over mid-year, so a term spanning New Year would
//      flip its own parity halfway through for no reason the user can see.
//   3. It has to agree with the term the entry hangs off, and terms are
//      exactly what this app already models. Anchoring to anything else would
//      mean two schedules attached at different levels disagreeing about
//      which week it is — in the same week.
//
// The count is in whole weeks from the term's start, aligned to the user's
// own week start, so a term beginning on a Wednesday still has its first
// MONDAY-to-Sunday block as week 1 rather than splitting week 1 across the
// boundary.

export const WEEK_EVERY = null;
export const WEEK_ODD = 1;
export const WEEK_EVEN = 2;

/**
 * Which parity week `iso` falls in, counted from `termStart`.
 *
 * @returns {1|2|null}  null when either date is unusable, which callers must
 *          treat as "show the lesson" — a lesson hidden because a date failed
 *          to parse is a lesson the student misses.
 */
export function weekParityOf(iso, termStart, weekStart = 1) {
  const day = parseLocalDate(iso);
  const start = parseLocalDate(termStart);
  if (!day || !start || Number.isNaN(day.getTime()) || Number.isNaN(start.getTime())) return null;

  // Snap both to the first day of their own week, so the answer changes only
  // at a week boundary and never mid-week.
  const snap = (d) => {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const shift = (copy.getDay() - weekStart + 7) % 7;
    copy.setDate(copy.getDate() - shift);
    return copy;
  };

  const a = snap(start);
  const b = snap(day);
  // Whole days, then whole weeks. Computed from local midnights rather than
  // by dividing raw timestamps: a DST transition inside the range shifts a
  // timestamp difference by an hour, and across a 26-week term that is enough
  // to land a boundary on the wrong side.
  const days = Math.round((b - a) / 86400000);
  const weeks = Math.floor(days / 7);
  // Week 1 is odd. Negative weeks (a date before the term starts) still
  // answer, because a caller may be previewing a schedule ahead of the term.
  return (((weeks % 2) + 2) % 2) === 0 ? WEEK_ODD : WEEK_EVEN;
}

/** Does an entry run on this date, given the parity of the week? */
export function entryRunsOnParity(entry, parity) {
  const want = entry?.weekParity;
  if (want !== WEEK_ODD && want !== WEEK_EVEN) return true; // every week
  if (parity === null) return true; // unknown parity — never hide a lesson
  return want === parity;
}

// ── Time-of-day ────────────────────────────────────────────────────────────
// Postgres `time without time zone` arrives as "08:15:00". Minutes past
// midnight is the only form the grid geometry uses, so conversion happens once
// here rather than at every call site.

/** "08:15" / "08:15:00" → 495. Returns null for anything unparseable, which
 *  callers must treat as "no lesson" rather than as midnight — a corrupt row
 *  should drop out of the render, not draw a band across the top of the day. */
export function timeToMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return clampMinute(value);
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h > 23 || min > 59) return null;
  return clampMinute(h * 60 + min);
}

function clampMinute(n) {
  return Math.max(0, Math.min(24 * 60, Math.round(n)));
}

/** 495 → "08:15". The DB column wants seconds, so `:00` is appended. */
export function minutesToTime(mins) {
  const n = clampMinute(mins);
  const h = Math.floor(n / 60), m = n % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function minutesToSqlTime(mins) {
  return `${minutesToTime(mins)}:00`;
}

// ── Term tree ──────────────────────────────────────────────────────────────

/** Live terms keyed by id. Soft-deleted rows stay in state for the LWW merge
 *  and must not appear in the tree. */
export function termIndex(terms) {
  const byId = new Map();
  for (const term of terms || []) {
    if (!term || term.deletedAt) continue;
    byId.set(term.id, term);
  }
  return byId;
}

/** `term` then each ancestor, nearest first. Cycle-safe: a corrupt parent
 *  chain (which the DB's `parent_id <> id` check cannot catch beyond one hop)
 *  would otherwise hang the render thread rather than draw a wrong calendar. */
export function ancestry(term, byId) {
  const chain = [];
  const seen = new Set();
  let cur = term;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain;
}

/** Resolved date range for a term: its own dates, falling back to the nearest
 *  ancestor that has one. Start and end resolve INDEPENDENTLY, so a jakso that
 *  knows when it begins but not when it ends still gets its parent's end date
 *  rather than being discarded whole.
 *
 *  Returns `{ from, to }` as ISO dates, either of which may be null. A term
 *  with neither has no occurrences — see `termCoversDate`. */
export function resolveTermRange(term, byId) {
  if (!term) return { from: null, to: null };
  let from = null, to = null;
  for (const node of ancestry(term, byId)) {
    if (from === null && node.startsOn) from = node.startsOn;
    if (to === null && node.endsOn) to = node.endsOn;
    if (from !== null && to !== null) break;
  }
  return { from, to };
}

/** Does `term` cover `iso`? An unbounded end means "still running" (the user
 *  has not said when this period stops), so it covers everything from the
 *  start onwards. An unbounded START, however, does NOT reach backwards
 *  forever — a timetable with no beginning would paint lessons across every
 *  historic week the user scrolls back through, which is worse than showing
 *  nothing. Both-null is therefore uncovered. */
export function termCoversDate(term, byId, iso) {
  const { from, to } = resolveTermRange(term, byId);
  if (!from) return false;
  if (iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

/** Terms covering `iso`, most specific first. */
export function termsOn(terms, iso) {
  const byId = termIndex(terms);
  const hits = [];
  for (const term of byId.values()) {
    if (termCoversDate(term, byId, iso)) hits.push(term);
  }
  hits.sort((a, b) => (levelRank(b.level) - levelRank(a.level)) || String(a.name || '').localeCompare(String(b.name || '')));
  return hits;
}

/** Every term beneath `id`, at any depth, excluding `id` itself.
 *  Deleting a school year has to take its semesters and jaksot with it — the
 *  DB's cascade only fires on a hard DELETE, and this app soft-deletes. */
export function descendantTermIds(terms, id) {
  const byParent = new Map();
  for (const term of termIndex(terms).values()) {
    const key = term.parentId || null;
    const list = byParent.get(key);
    if (list) list.push(term.id);
    else byParent.set(key, [term.id]);
  }
  const out = [];
  const queue = [id];
  const seen = new Set([id]);
  while (queue.length) {
    for (const childId of byParent.get(queue.shift()) || []) {
      if (seen.has(childId)) continue; // cycle guard, same reasoning as `ancestry`
      seen.add(childId);
      out.push(childId);
      queue.push(childId);
    }
  }
  return out;
}

/** Children of `parentId` (null for roots), ordered by position then name. */
export function childrenOf(terms, parentId) {
  const out = [];
  for (const term of termIndex(terms).values()) {
    if ((term.parentId || null) === (parentId || null)) out.push(term);
  }
  out.sort((a, b) => (a.position - b.position) || String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}

// ── Lesson occurrences ─────────────────────────────────────────────────────

/**
 * Lessons falling on `iso`.
 *
 * SPECIFICITY, the rule the one-table model exists to make expressible: when a
 * date is covered by both a jakso and the semester containing it, and BOTH
 * carry timetable entries, the jakso's win outright for that date. The owner's
 * framing is that a semester-wide schedule is what you make *when the jaksot
 * do not differ* — so the moment a jakso has its own entries, it is by
 * definition the exception, and drawing both would show every lesson twice on
 * the days the user took the trouble to override.
 *
 * A term with no entries is transparent rather than blocking: an empty jakso
 * inside a scheduled semester falls through to the semester, which is the only
 * reading that does not make creating a period erase the timetable.
 *
 * Returns occurrences sorted by start time, each carrying resolved course
 * colour/name so the caller does no lookups.
 */
export function lessonsOn(state, iso, weekStart = 1) {
  const entries = state.timetableEntries || [];
  if (!entries.length) return [];
  const date = parseLocalDate(iso);
  if (!date || Number.isNaN(date.getTime())) return [];
  const weekday = date.getDay();

  const covering = termsOn(state.academicTerms || [], iso);
  if (!covering.length) return [];

  const live = entries.filter((e) => e && !e.deletedAt);
  // Highest specificity that actually has entries for this weekday wins.
  // Ranked by level, so a period beats the semester above it. Terms at the
  // SAME level are not an override of one another — two semesters covering one
  // date is a data error, not a hierarchy — so they accumulate.
  let chosenRank = -1;
  let chosen = [];
  for (const term of covering) {
    const rank = levelRank(term.level);
    if (rank < chosenRank) break; // covering[] is sorted most-specific first
    // v1.13 — parity is resolved against THIS term's start, so an entry
    // attached to a jakso alternates on the jakso's own clock and one
    // attached to the semester alternates on the semester's. Two schedules at
    // different levels can therefore both be right about "week A" without
    // agreeing with each other, which is the only reading that survives a
    // period being inserted mid-semester.
    const parity = weekParityOf(iso, term.startsOn, weekStart);
    const forTerm = live.filter((e) => (
      e.termId === term.id && e.weekday === weekday && entryRunsOnParity(e, parity)
    ));
    // Specificity is decided by whether a term has entries for this weekday AT
    // ALL, not by whether they run this week. Otherwise a jakso whose only
    // Tuesday lesson is fortnightly would fall through to the semester on the
    // off week and draw the semester's Tuesday instead — an override that
    // silently stops overriding every other week.
    const anyForTerm = live.some((e) => e.termId === term.id && e.weekday === weekday);
    if (!anyForTerm) continue;
    if (rank > chosenRank) { chosenRank = rank; chosen = []; }
    chosen.push(...forTerm.map((e) => ({ entry: e, term })));
    continue;
  }
  if (!chosen.length) return [];

  const out = [];
  for (const { entry, term } of chosen) {
    const startMin = timeToMinutes(entry.startsAt);
    const endMin = timeToMinutes(entry.endsAt);
    // A row that fails either parse, or whose end is not after its start, is
    // dropped rather than clamped. Clamping would invent a duration the user
    // never entered and draw it as fact.
    if (startMin === null || endMin === null || endMin <= startMin) continue;
    const course = entry.subjectId ? state.courses?.[entry.subjectId] : null;
    const liveCourse = course && !course.deletedAt ? course : null;
    out.push({
      kind: 'lesson',
      id: entry.id,
      iso,
      termId: term.id,
      termName: term.name,
      // The entry's own title wins over the course name: someone who typed
      // "Maths — lab" meant to distinguish it from the lecture.
      title: entry.title || liveCourse?.name || null,
      courseId: entry.subjectId || null,
      courseName: liveCourse?.name || null,
      color: entry.color || liveCourse?.color || null,
      room: entry.room || null,
      weekParity: entry.weekParity ?? null,
      startMin,
      endMin,
      durationMinutes: endMin - startMin,
      source: entry,
    });
  }
  out.sort((a, b) => (a.startMin - b.startMin) || String(a.title || '').localeCompare(String(b.title || '')));
  return out;
}

/** Free stretches between lessons on `iso`, within `[dayFrom, dayTo]` minutes.
 *  This is what makes the time-management framing work — "Tuesday evening is
 *  already gone" is only visible if the gaps are computed, not eyeballed.
 *  Gaps shorter than `minGap` are not free time in any useful sense. */
export function freeGaps(lessons, dayFrom = 8 * 60, dayTo = 20 * 60, minGap = 30) {
  const busy = lessons
    .map((l) => ({ from: l.startMin, to: l.endMin }))
    .sort((a, b) => a.from - b.from);
  const merged = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.from <= last.to) last.to = Math.max(last.to, b.to);
    else merged.push({ ...b });
  }
  const gaps = [];
  let cursor = dayFrom;
  for (const b of merged) {
    if (b.from > cursor) gaps.push({ from: cursor, to: Math.min(b.from, dayTo) });
    cursor = Math.max(cursor, b.to);
    if (cursor >= dayTo) break;
  }
  if (cursor < dayTo) gaps.push({ from: cursor, to: dayTo });
  return gaps.filter((g) => g.to - g.from >= minGap && g.to > g.from);
}

/** Local ISO timestamp for a planned block at `iso` + `minutes`.
 *  Built from local calendar fields rather than by adding milliseconds to a
 *  UTC midnight: a DST boundary shifts the offset mid-week, and arithmetic on
 *  the instant would land a Monday 09:00 block at 08:00 or 10:00 depending on
 *  which side of the change it fell. */
export function localTimestamp(iso, minutes) {
  const d = parseLocalDate(iso);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

/** Inverse of the above, for reading a stored planned block back onto a grid. */
export function dayAndMinuteOf(startsAt) {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return null;
  return { iso: toLocalISO(d), minutes: d.getHours() * 60 + d.getMinutes() };
}
