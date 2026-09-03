// Lesson attendance. Issue #31, `deflate8818`, waiting since 2026-08-25.
//
// Four states — present / absent / cancelled / rescheduled — keyed to one
// lesson on one date, with a per-term percentage.
//
// ── Why the percentage is computed and never stored ──────────────────────
//
// The build plan asks for "percentage as a view or client aggregate, not a
// stored counter", and that is the right call for a reason worth writing
// down: a stored counter has to be updated by every path that can change an
// attendance row, and this app has several — a local edit, an outbox drain, a
// realtime echo from another device, and `applyRemotePull`'s LWW merge. A
// counter that four paths can increment is a counter that will eventually be
// wrong, and a wrong attendance percentage is the kind of number a student
// takes to a teacher.
//
// Computed from the rows, it cannot drift. It is also cheap: a school year is
// on the order of a few hundred rows.
//
// ── Which lessons count ──────────────────────────────────────────────────
//
// CANCELLED IS NOT AN ABSENCE, and this is the whole subtlety of the feature.
// A lesson the school cancelled did not happen, so it belongs in neither the
// numerator nor the denominator — counting it as an absence would punish a
// student for their timetable, and counting it as attendance would inflate
// the figure. RESCHEDULED is the same: the lesson moved, and the instance
// that actually happened is recorded on its own date.
//
// So: percentage = present / (present + absent).

/** The four states. Stored as text, not an enum, for the same reason
 *  assignment `type` is text: a local value this server does not know about
 *  must not fail the upsert. */
export const ATTENDANCE = {
  PRESENT: 'present',
  ABSENT: 'absent',
  CANCELLED: 'cancelled',
  RESCHEDULED: 'rescheduled',
};

export const ATTENDANCE_STATES = [
  ATTENDANCE.PRESENT,
  ATTENDANCE.ABSENT,
  ATTENDANCE.CANCELLED,
  ATTENDANCE.RESCHEDULED,
];

/** States that put a lesson in the denominator. */
const COUNTED = new Set([ATTENDANCE.PRESENT, ATTENDANCE.ABSENT]);

export function isCounted(status) {
  return COUNTED.has(status);
}

/** One row's key. `(entryId, date)` is the identity — the same lesson on the
 *  same day is one fact, whatever device recorded it. */
export function attendanceKey(entryId, iso) {
  return `${entryId}::${iso}`;
}

/** Index rows for O(1) lookup while rendering a week. */
export function indexAttendance(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r || r.deletedAt) continue;
    map.set(attendanceKey(r.timetableEntryId, r.date), r);
  }
  return map;
}

export function statusFor(index, entryId, iso) {
  return index.get(attendanceKey(entryId, iso))?.status ?? null;
}

/**
 * Attendance summary over a set of rows.
 *
 * @returns {{present, absent, cancelled, rescheduled, counted, percent}}
 *
 * `percent` is null rather than 0 when nothing has been recorded. A student
 * who has not marked anything has not attended 0% of their lessons — they
 * have no data, and showing "0%" would be a false statement about them in
 * the one place they might screenshot it.
 */
export function summarise(rows) {
  const tally = { present: 0, absent: 0, cancelled: 0, rescheduled: 0 };
  for (const r of rows || []) {
    if (!r || r.deletedAt) continue;
    if (tally[r.status] === undefined) continue; // unknown state from a newer build
    tally[r.status] += 1;
  }
  const counted = tally.present + tally.absent;
  return {
    ...tally,
    counted,
    percent: counted > 0 ? (tally.present / counted) * 100 : null,
  };
}

/**
 * Per-term summary. `academic_terms` supplies the school-year boundary, per
 * the build plan.
 *
 * Rows are assigned to a term by DATE, not by the entry's `termId`. A lesson
 * belonging to a semester-level schedule still happened inside whichever
 * jakso covers that date, and a student asking "what is my attendance this
 * jakso" means the dates, not the schedule's attachment point.
 *
 * @param {Array} rows      attendance rows
 * @param {object} term     the term to summarise
 * @param {Function} covers `(term, iso) => boolean`
 */
export function summariseTerm(rows, term, covers) {
  if (!term) return summarise([]);
  return summarise((rows || []).filter((r) => r && !r.deletedAt && covers(term, r.date)));
}

/**
 * Per-course breakdown within a set of rows.
 *
 * Keyed by the course the timetable entry points at, so "I have missed four
 * Physics lessons" is answerable — which is the question behind the request,
 * more than the overall figure is.
 */
export function summariseByCourse(rows, entriesById) {
  const buckets = new Map();
  for (const r of rows || []) {
    if (!r || r.deletedAt) continue;
    const entry = entriesById.get(r.timetableEntryId);
    const courseId = entry?.subjectId || null;
    if (!buckets.has(courseId)) buckets.set(courseId, []);
    buckets.get(courseId).push(r);
  }
  const out = [];
  for (const [courseId, courseRows] of buckets) {
    out.push({ courseId, ...summarise(courseRows) });
  }
  // Worst attendance first — that is the row the student needs to see, and a
  // course with nothing recorded sorts last rather than as 0%.
  out.sort((a, b) => {
    if (a.percent === null && b.percent === null) return 0;
    if (a.percent === null) return 1;
    if (b.percent === null) return -1;
    return a.percent - b.percent;
  });
  return out;
}

/** Cycle order for tapping a lesson: unmarked → present → absent → cancelled
 *  → rescheduled → unmarked. Present first because it is by far the most
 *  common answer, so the common case is one tap. */
const CYCLE = [null, ATTENDANCE.PRESENT, ATTENDANCE.ABSENT, ATTENDANCE.CANCELLED, ATTENDANCE.RESCHEDULED];

export function nextStatus(current) {
  const i = CYCLE.indexOf(current ?? null);
  return CYCLE[(i + 1) % CYCLE.length];
}
