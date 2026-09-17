// v1.14 Item 5 (#51, "EDITED ADDITION") — a deadline has a time, not just a day.
//
//   > "It would also be great if you could put the time when an assignment is
//      due, not just the date."
//
// The ask is small and the reason is not: "due Friday" and "due Friday 09:00"
// are different instructions on a Thursday night. An assignment due at midnight
// can be finished after dinner; one due at 09:00 cannot be started then.
//
// ── WHY A SEPARATE COLUMN, NOT A WIDER ONE ────────────────────────────────
//
// The build plan proposed "widening the due-date field to a full timestamp".
// That is a type change on `assignments.due_date`, which is a `date` column
// that EVERY shipped app version reads, and `P1` forbids it outright: old
// versions stay on F-Droid indefinitely and a `date` that starts returning a
// timestamp changes what `due_date === todayISO` means in every one of them.
//
// So the time is its own nullable `due_time` column, and `due_date` is
// untouched. An older app opening a timed assignment sees exactly what it sees
// today — the right day, no time — rather than a row it half-understands.
//
// ── WHY END-OF-DAY IS THE DEFAULT, NOT MIDNIGHT ───────────────────────────
//
// Every existing assignment has no time, and the app must keep treating those
// as "some time that day". Sorting them at 00:00 would file a deadline nobody
// has given a time to AHEAD of a 09:00 one on the same morning, which asserts
// something the user never said. 23:59 asserts the other thing — "later that
// day, unspecified" — which is what "due Friday" has always meant here.
//
// This module is the only place that knows either rule.

import { timeToMinutes } from './timetable.js';

/** Where an untimed assignment sits within its day. See the note above. */
export const END_OF_DAY = '23:59';

/**
 * Anything stored, typed or pulled, as `HH:MM` — or '' for "no time".
 *
 * Postgres `time` columns come back as `HH:MM:SS`, `<input type="time">` emits
 * `HH:MM`, and a hand-edited localStorage blob can hold anything at all. One
 * normaliser, called on every path in, so no consumer has to care which.
 */
export function normalizeDueTime(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const mins = timeToMinutes(raw);
  // `timeToMinutes` rejects an hour above 23, which includes Postgres's legal
  // `24:00:00`. That falls through to '' — "no time given" — and no
  // information is lost by it: '' already sorts as END_OF_DAY, which is what
  // 24:00 means, and the app has no path that writes such a value anyway. The
  // alternative would be rendering a 23:59 nobody typed.
  if (mins === null) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** `HH:MM:00` for the `time` column, or null. Matches how commitments store
 *  their wall-clock times, so both tables read the same way in psql. */
export function dueTimeToSql(value) {
  const t = normalizeDueTime(value);
  return t ? `${t}:00` : null;
}

/**
 * A sortable key for "when is this due", undated items last.
 *
 * A STRING, compared with `<`, rather than two Date objects subtracted. The
 * existing comparators built a Date per item per comparison — O(n log n)
 * allocations on every render of a list that can hold a whole term — and, more
 * to the point, `new Date('2026-09-14')` parses as UTC midnight while
 * `new Date('2026-09-14T09:00')` parses as LOCAL, so mixing timed and untimed
 * items through the Date constructor would sort them by two different clocks.
 * Lexicographic order on a fixed-width `YYYY-MM-DDTHH:MM` is the same order,
 * with no timezone in it at all.
 */
export function dueSortKey(dueDate, dueTime) {
  if (!dueDate) return '9999-12-31T23:59';
  return `${dueDate}T${normalizeDueTime(dueTime) || END_OF_DAY}`;
}

/** Ready to hand to `Array.prototype.sort`, soonest first. */
export function byDueAsc(a, b) {
  const ka = dueSortKey(a?.dueDate, a?.dueTime);
  const kb = dueSortKey(b?.dueDate, b?.dueTime);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Most recent first — the order the "completed" lists use.
 *
 * NOT `-byDueAsc`. Undated items sort LAST in both directions, which a simple
 * negation would not do: ascending files them last behind a far-future
 * sentinel, and negating that would float them to the top of the completed
 * list. "Most recent first" does not mean an assignment nobody ever dated is
 * the most recent thing that happened — it means nobody dated it. The old
 * comparator got this right with a `1970-01-01` fallback and it is preserved
 * here deliberately.
 */
export function byDueDesc(a, b) {
  const ka = a?.dueDate ? dueSortKey(a.dueDate, a.dueTime) : '';
  const kb = b?.dueDate ? dueSortKey(b.dueDate, b.dueTime) : '';
  return ka < kb ? 1 : ka > kb ? -1 : 0;
}

/**
 * The local Date a deadline actually falls on, or null.
 *
 * Built from parts rather than parsed from a string, for the UTC reason in
 * `dueSortKey` — and this one is the path notifications are scheduled on, so
 * getting it wrong moves an alarm by the user's whole UTC offset.
 */
export function dueMoment(dueDate, dueTime) {
  if (!dueDate) return null;
  const [y, mo, d] = String(dueDate).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const mins = timeToMinutes(normalizeDueTime(dueTime) || END_OF_DAY);
  const out = new Date(y, mo - 1, d, 0, 0, 0, 0);
  out.setMinutes(mins);
  return out;
}

/**
 * When to fire the due-day reminder.
 *
 * It has always been 09:00. That is fine for a deadline at 17:00 and useless
 * for one at 08:00, which is precisely the case this item introduces — so the
 * reminder moves earlier when it has to, and never later. An hour of warning
 * is the least that is worth sending.
 *
 * Returns null when the deadline is so early that an hour before it is the
 * previous day: the day-before reminder at 18:00 already covers that, and a
 * "Due today" notification arriving yesterday is worse than none.
 */
export function dueDayReminderAt(dueDate, dueTime) {
  const deadline = dueMoment(dueDate, dueTime);
  if (!deadline) return null;

  // Midnight is taken by zeroing the deadline rather than by asking dueMoment
  // for it: dueMoment's whole contract is that an absent time means END OF
  // day, so passing it null would return 23:59 and every comparison below
  // would be against the wrong end of the day.
  const day = new Date(deadline.getTime());
  day.setHours(0, 0, 0, 0);
  const nine = new Date(day.getTime());
  nine.setHours(9, 0, 0, 0);

  if (!normalizeDueTime(dueTime)) return nine;

  const hourBefore = new Date(deadline.getTime() - 60 * 60 * 1000);
  if (hourBefore < day) return null;
  return hourBefore < nine ? hourBefore : nine;
}
