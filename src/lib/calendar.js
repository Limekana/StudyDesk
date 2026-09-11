// v1.9 Item 14a — calendar geometry and the event model behind it.
//
// Pure module: no React, no DOM, no i18n side effects. Month view, week view
// and the ICS export all read the same normalised events from here, so a
// deadline cannot appear on one surface and not another — the failure mode
// when each view filters `state` for itself.
//
// Everything is a local YYYY-MM-DD string ("iso" below) rather than a Date.
// `parseLocalDate`/`toLocalISO` already exist for exactly this reason: the app
// stores due dates as calendar days, and a Date carries a time and a zone that
// will eventually shift one of them across midnight.

import { parseLocalDate, toLocalISO, addDays } from './dates.js';
import { DIFFICULTY_DAYS } from './examDifficulty.js';

// ── Week start ─────────────────────────────────────────────────────────────
// The grid StudyDesk shipped until now started every week on Sunday for every
// user, including the Finnish, French, German, Spanish and Portuguese ones,
// where the week starts on Monday. That is not a preference — a Monday-start
// reader parses a Sunday-start grid off by one column all the way down it.
//
// `Intl.Locale.prototype.weekInfo` answers this properly and is available in
// the Chromium the app ships inside, so it is the real answer and the table
// below is only a fallback for the case where it is missing.
//
// The fallback is deliberately coarse and is NOT a guess dressed up as data —
// checked against CLDR rather than assumed, because the assumption was wrong:
// of the app's ten locales, Portuguese, Hindi and Indonesian start on Sunday
// as well as US/Canadian English, and Egyptian Arabic starts on SATURDAY.
// Only regions the app actually ships a locale for are listed; anything else
// falls to Monday (ISO 8601). Saturday is intentionally absent here — it is
// reachable through weekInfo, but an Arabic reader's correct answer varies by
// country (EG Saturday, SA Sunday) and a fallback cannot tell them apart, so
// it declines to guess rather than picking one and being wrong half the time.
const SUNDAY_FIRST_REGIONS = new Set(['US', 'CA', 'PT', 'BR', 'IN', 'ID']);

// v1.13 — the user's own override, when they have set one.
//
// CLDR is right about what a locale's week START conventionally is, and the
// resolution below is correct: `ar-EG` answers Saturday, `en-GB` Monday,
// `en-US` Sunday. It was still worth adding an override, because the report
// that prompted this ("the week starts on Sunday", 2026-09-02, 5/5) is not a
// locale bug — it is a person whose locale genuinely says Sunday and who
// wants Monday anyway. A student's week starts when their timetable does, and
// that is not always what their region does on average.
//
// Device-level and local-only, like the grade scale: it is a display
// preference, not academic data, and syncing it would mean a shared iPad
// changing one person's grid because another person prefers Monday.
export const WEEK_START_KEY = 'studydesk-week-start';

export function preferredWeekStart() {
  try {
    const raw = localStorage.getItem(WEEK_START_KEY);
    if (raw === null || raw === 'auto') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
  } catch {
    return null;
  }
}

export function setPreferredWeekStart(value) {
  try {
    if (value === null || value === 'auto') localStorage.removeItem(WEEK_START_KEY);
    else localStorage.setItem(WEEK_START_KEY, String(value));
  } catch {
    /* private mode — the choice just won't survive a relaunch */
  }
}

export function resolveWeekStart(locale) {
  // The override wins outright. Checked FIRST rather than as a fallback: a
  // user who has said "Monday" means it on every locale, including one whose
  // CLDR answer changes when they travel.
  const chosen = preferredWeekStart();
  if (chosen !== null) return chosen;
  try {
    const l = new Intl.Locale(locale);
    // weekInfo is 1=Monday … 7=Sunday; this module uses JS's 0=Sunday … 6.
    const first = l.weekInfo?.firstDay ?? l.getWeekInfo?.().firstDay;
    if (first) return first === 7 ? 0 : first;
  } catch {
    /* fall through to the table below */
  }
  const region = String(locale || '').split('-')[1];
  return region && SUNDAY_FIRST_REGIONS.has(region.toUpperCase()) ? 0 : 1;
}

/** Short weekday names in grid order, from the locale rather than translation
 *  keys. Intl already knows "ma ti ke to pe la su" for Finnish; a `cal.mon`
 *  key would be ten more strings to keep correct, and would still be wrong the
 *  moment the week start moves. */
export function weekdayLabels(weekStart, locale) {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // 2024-01-07 was a Sunday, so +i lands on weekday i.
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2024, 0, 7 + ((weekStart + i) % 7))));
}

/** The iso of the first day of the week `iso` falls in. */
export function startOfWeek(iso, weekStart) {
  const d = parseLocalDate(iso);
  const shift = (d.getDay() - weekStart + 7) % 7;
  return addDays(iso, -shift);
}

/** Rows of 7 iso days covering `month`, padded out to whole weeks.
 *  Deliberately NOT padded to a fixed six rows: a 28-day February starting on
 *  the week boundary needs four, and forcing a fifth empty row would leave a
 *  band of dead space at the bottom of the sheet. Row count varies, row height
 *  does not. */
export function monthGrid(year, month, weekStart) {
  const first = toLocalISO(new Date(year, month, 1));
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const last = toLocalISO(new Date(year, month, daysInMonth));
  let cursor = startOfWeek(first, weekStart);
  const end = startOfWeek(last, weekStart);
  const rows = [];
  // Inclusive of the row containing the last day, hence the post-test loop.
  for (;;) {
    const row = Array.from({ length: 7 }, (_, i) => {
      const iso = addDays(cursor, i);
      const d = parseLocalDate(iso);
      return { iso, day: d.getDate(), inMonth: d.getMonth() === month };
    });
    rows.push(row);
    if (cursor === end) break;
    cursor = addDays(cursor, 7);
  }
  return rows;
}

export function weekGrid(anchorIso, weekStart) {
  const start = startOfWeek(anchorIso, weekStart);
  return Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(start, i);
    return { iso, day: parseLocalDate(iso).getDate() };
  });
}

// ── Events ─────────────────────────────────────────────────────────────────
// Four kinds, in deliberate visual and semantic priority order:
//
//   exam        a fixed, high-stakes date            — ink chip
//   assignment  a fixed due date                     — course-coloured rule
//   study       the revision window before an exam   — spanning band
//   session     a logged block of actual study time  — has a clock time
//
// `study` is derived, not stored: the app already computes a start date from
// the exam's difficulty (`studyStartDate` in App.jsx). The old mini-grid drew
// a marker on that single start day, which reads as "one thing happens here"
// when what it means is "this whole stretch is spoken for". It is a band.

// `planned` joined in v1.10: a block the user intends to study, stored in its
// own `planned_sessions` table. It is deliberately NOT a flag on
// `study_sessions` — NCC derives study signals and its Life Score from that
// table, and a flag there would count intentions as work done in an app that
// has already shipped and can never be taught to filter it.
//
// Lessons are NOT in this list, and that is not an oversight: they are a
// recurring skeleton generated per date from `timetable_entries` (see
// `lib/timetable.js`), not stored events. The week grid and the day agenda
// draw them as a background layer; the month sheet does not, because five
// lessons a day would bury the exams and deadlines the month exists to show.
export const EVENT_KINDS = ['exam', 'assignment', 'study', 'session', 'planned'];

function courseOf(state, id) {
  const c = state.courses?.[id];
  return c && !c.deletedAt ? c : null;
}

export function studyWindowStart(exam) {
  if (!exam?.dueDate) return null;
  return addDays(exam.dueDate, -(DIFFICULTY_DAYS[exam.difficulty || 'medium'] ?? 0));
}

/** Minutes past local midnight for a stored session timestamp. */
export function minutesIntoDay(startedAt) {
  const d = new Date(startedAt);
  return d.getHours() * 60 + d.getMinutes();
}

/** All dated items, normalised.
 *
 *  Returns `{ byDay, bands }`:
 *   - `byDay`   Map<iso, item[]> for everything that lands on one day
 *   - `bands`   multi-day study windows, laid out separately (see layoutBands)
 *
 *  `opts.includeDone` keeps completed exams/assignments in the result. The
 *  month grid wants them (a past exam is still a fact about that day, and
 *  hiding it makes the sheet lie about a week you actually lived through);
 *  the study *bands* do not, since revising for a finished exam is over.
 */
export function buildEvents(state, opts = {}) {
  const { includeDone = true } = opts;
  const byDay = new Map();
  const push = (iso, item) => {
    if (!iso) return;
    const list = byDay.get(iso);
    if (list) list.push(item);
    else byDay.set(iso, [item]);
  };

  for (const e of state.exams || []) {
    if (!includeDone && e.done) continue;
    const course = courseOf(state, e.courseId);
    push(e.dueDate, {
      kind: 'exam',
      id: e.id,
      title: e.title,
      iso: e.dueDate,
      done: !!e.done,
      courseId: e.courseId,
      courseName: course?.name || null,
      color: course?.color || null,
      difficulty: e.difficulty || 'medium',
      notes: e.notes || '',
      topics: e.topics || [],
      source: e,
    });
  }

  for (const a of state.assignments || []) {
    if (!includeDone && a.done) continue;
    const course = courseOf(state, a.courseId);
    push(a.dueDate, {
      kind: 'assignment',
      id: a.id,
      title: a.title,
      iso: a.dueDate,
      done: !!a.done,
      courseId: a.courseId,
      courseName: course?.name || null,
      color: course?.color || null,
      type: a.type || null,
      notes: a.notes || '',
      source: a,
    });
  }

  for (const s of state.studySessions || []) {
    // Soft-deleted rows stay in state so the LWW merge can resolve them; they
    // are not events.
    if (s.deletedAt) continue;
    if (!s.startedAt) continue;
    const iso = toLocalISO(new Date(s.startedAt));
    const course = courseOf(state, s.subjectId);
    push(iso, {
      kind: 'session',
      id: s.id,
      title: course?.name || null,
      iso,
      courseId: s.subjectId,
      courseName: course?.name || null,
      color: course?.color || null,
      startedAt: s.startedAt,
      startMin: minutesIntoDay(s.startedAt),
      durationMinutes: s.durationMinutes,
      focusRating: s.focusRating ?? null,
      notes: s.notes || '',
      source: s,
    });
  }

  for (const p of state.plannedSessions || []) {
    if (p.deletedAt) continue;
    if (!p.startsAt) continue;
    const when = new Date(p.startsAt);
    if (Number.isNaN(when.getTime())) continue;
    const iso = toLocalISO(when);
    const course = courseOf(state, p.subjectId);
    // Three outcomes, and the block says which: kept (a session got linked to
    // it), dropped (explicitly dismissed), or still owed. `missed` is derived
    // rather than stored, because storing it would need a job to run at
    // midnight — the passage of time is not an edit anyone makes.
    const status = p.fulfilledBy ? 'kept' : p.dismissedAt ? 'dismissed' : (when.getTime() < Date.now() ? 'missed' : 'planned');
    push(iso, {
      kind: 'planned',
      id: p.id,
      title: p.title || course?.name || null,
      iso,
      courseId: p.subjectId,
      courseName: course?.name || null,
      color: course?.color || null,
      startedAt: p.startsAt,
      startMin: minutesIntoDay(p.startsAt),
      durationMinutes: p.durationMinutes,
      status,
      done: status === 'kept' || status === 'dismissed',
      notes: p.notes || '',
      source: p,
    });
  }

  const bands = [];
  for (const e of state.exams || []) {
    if (e.done || !e.dueDate) continue;
    const from = studyWindowStart(e);
    // A zero-day window (difficulty with no lead time) is not a band — it
    // would render as a one-cell stub duplicating the exam chip beneath it.
    if (!from || from >= e.dueDate) continue;
    const course = courseOf(state, e.courseId);
    bands.push({
      id: e.id,
      title: e.title,
      from,
      // Exclusive of the exam day itself: the day you sit it is not a day you
      // revise for it, and letting the band run under the chip reads as an
      // extra commitment on the hardest day of the set.
      to: addDays(e.dueDate, -1),
      courseId: e.courseId,
      courseName: course?.name || null,
      color: course?.color || null,
      difficulty: e.difficulty || 'medium',
    });
  }

  return { byDay, bands };
}

/** Order within a day cell. Exams first because they are the immovable thing
 *  on that date; sessions last and by clock time, since they are a record of
 *  the day rather than a demand on it. */
// `commitment` is ranked even though it is generated per date rather than
// stored (see lib/commitments.js) — the month sheet mixes it into the same
// sorted cell list, and a kind missing from this table yields NaN from the
// subtraction below, which makes the comparator return NaN and the sort
// order implementation-defined.
const KIND_RANK = { exam: 0, assignment: 1, study: 2, commitment: 3, planned: 4, session: 5 };

/** Kinds that own a clock time and therefore belong in the hour grid rather
 *  than the all-day strip above it. */
export const TIMED_KINDS = new Set(['session', 'planned', 'commitment']);

export function sortDayItems(items) {
  return items.slice().sort((a, b) => {
    // Coerced, not compared raw. Sessions carry no `done` field at all, so
    // `undefined !== false` is true and the raw form returned "a comes first"
    // for BOTH orderings of the same pair — a non-transitive comparator, whose
    // output then depends on the order items happened to be pushed in.
    const aDone = !!a.done, bDone = !!b.done;
    if (aDone !== bDone) return aDone ? 1 : -1;
    const r = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (r !== 0) return r;
    if (a.kind === 'session' && b.kind === 'session') return a.startMin - b.startMin;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

// ── Band layout ────────────────────────────────────────────────────────────
// A study window crossing a week boundary is one commitment drawn as two
// segments, one per row. Each row packs its segments into lanes so two windows
// that overlap in time sit on separate lines instead of on top of each other.
//
// Greedy first-fit after sorting by start then by length: the longest run
// claims the top lane, which keeps the tallest thing in the row from being
// pushed down by a two-day stub that happens to start earlier.

export function layoutBands(bands, rowDays) {
  if (!bands.length || !rowDays.length) return { segments: [], lanes: 0 };
  const rowStart = rowDays[0].iso;
  const rowEnd = rowDays[rowDays.length - 1].iso;

  const clipped = [];
  for (const band of bands) {
    if (band.to < rowStart || band.from > rowEnd) continue;
    const from = band.from < rowStart ? rowStart : band.from;
    const to = band.to > rowEnd ? rowEnd : band.to;
    const startCol = rowDays.findIndex((d) => d.iso === from);
    const endCol = rowDays.findIndex((d) => d.iso === to);
    if (startCol < 0 || endCol < 0) continue;
    clipped.push({
      band,
      startCol,
      span: endCol - startCol + 1,
      continuesLeft: band.from < rowStart,
      continuesRight: band.to > rowEnd,
    });
  }

  clipped.sort((a, b) => (a.startCol - b.startCol) || (b.span - a.span));

  const laneEnds = []; // exclusive column index each lane is free from
  for (const seg of clipped) {
    let lane = laneEnds.findIndex((end) => end <= seg.startCol);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = seg.startCol + seg.span;
    seg.lane = lane;
  }

  return { segments: clipped, lanes: laneEnds.length };
}

// ── Ranges ─────────────────────────────────────────────────────────────────

/** Sessions on `iso`, ordered by clock time. Week view reads this per column. */
export function sessionsOn(byDay, iso) {
  return (byDay.get(iso) || [])
    .filter((it) => it.kind === 'session')
    .sort((a, b) => a.startMin - b.startMin);
}

/** Everything with a clock time on `iso` — logged sessions AND planned blocks,
 *  which share the hour grid because they occupy the same hours. Ordered by
 *  start, then planned before logged at an identical minute so a block and the
 *  session that fulfilled it read in the order they happened. */
export function timedOn(byDay, iso) {
  return (byDay.get(iso) || [])
    .filter((it) => TIMED_KINDS.has(it.kind))
    .sort((a, b) => (a.startMin - b.startMin) || (KIND_RANK[a.kind] - KIND_RANK[b.kind]));
}

/** Untimed items on `iso` — the all-day strip above the week's hour grid. */
export function allDayOn(byDay, iso) {
  return sortDayItems((byDay.get(iso) || []).filter((it) => !TIMED_KINDS.has(it.kind)));
}

/** Side-by-side placement for overlapping sessions in one day column.
 *  Two sessions logged over the same hour would otherwise draw on top of each
 *  other and the shorter one would be invisible. Columns are assigned within
 *  each cluster of mutually-overlapping blocks, so a day with no overlap keeps
 *  full-width blocks rather than being narrowed by an unrelated clash. */
export function layoutDayColumn(sessions) {
  const out = [];
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const colEnds = [];
    for (const s of cluster) {
      let col = colEnds.findIndex((end) => end <= s.startMin);
      if (col === -1) { col = colEnds.length; colEnds.push(0); }
      colEnds[col] = s.startMin + Math.max(15, s.durationMinutes || 0);
      out.push({ item: s, col, of: 0, _cluster: cluster });
    }
    const width = colEnds.length;
    for (const o of out) if (o._cluster === cluster) { o.of = width; delete o._cluster; }
    cluster = [];
    clusterEnd = -1;
  };

  for (const s of sessions) {
    const end = s.startMin + Math.max(15, s.durationMinutes || 0);
    if (cluster.length && s.startMin >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}
