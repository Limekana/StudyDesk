// v1.10 — commitments: the non-study blocks in the calendar.
//
// Owner: "I want there to be possible to make these type of blockers in the
// calendar for example trainings etc." — and, from the v1.10 mobile-calendar
// note, the reason: "for me it could be good as I have loads of training
// sessions". This is the other half of the time-management framing. A week is
// only plannable if the time you have already committed is visible; otherwise
// the app cheerfully suggests revising on a Tuesday evening that is spoken for.
//
// A commitment is NOT study and never touches a study statistic. It is not a
// planned session either: a plan is an intention to study that you either keep
// or drop, whereas training simply happens and asking whether you "fulfilled"
// it is the wrong question. Hence its own table.
//
// TWO SHAPES, ONE TABLE, switched on `weekday`:
//   weekday === null  ->  one-off on `startsOn`
//   weekday !== null  ->  weekly, from `startsOn` until `endsOn` (or open)
// A full recurrence grammar (RRULE, "every other Thursday", monthly-by-nth)
// was deliberately not adopted. These two shapes cover training, clubs, shifts
// and a one-off match; the rest is a lot of machinery for the remainder, and
// it can be added later without moving what is already stored.
//
// TIMES ARE WALL-CLOCK. `start_time`/`end_time` are `time` columns, not
// timestamps: training is at 18:00 local whatever the UTC offset happens to be
// that week. This makes the DST boundary a non-event here, rather than
// something every read has to be careful about.

import { parseLocalDate } from './dates.js';
import { timeToMinutes } from './timetable.js';

/** Live commitments only. Soft-deleted rows stay in state so the LWW merge can
 *  resolve them; they are not occurrences. */
function live(commitments) {
  return (commitments || []).filter((c) => c && !c.deletedAt);
}

export function isWeekly(c) {
  return c?.weekday !== null && c?.weekday !== undefined && Number.isFinite(Number(c.weekday));
}

/**
 * Does `c` fall on `iso`?
 *
 * Dates are compared as ISO strings, which sort correctly and sidestep the
 * timezone question entirely — every value here is a local calendar date, and
 * turning them into Date objects only to compare them would reintroduce the
 * offset bug this model exists to avoid.
 */
export function occursOn(c, iso, weekdayOfIso) {
  if (!c || !c.startsOn) return false;
  if (!isWeekly(c)) return c.startsOn === iso;
  if (Number(c.weekday) !== weekdayOfIso) return false;
  if (iso < c.startsOn) return false;
  // An absent end date means "still running" — the normal state for a club you
  // have not decided the last week of.
  if (c.endsOn && iso > c.endsOn) return false;
  return true;
}

/**
 * Commitment occurrences on `iso`, ordered by start time.
 *
 * Returns the same block shape the calendar's other timed kinds use
 * (`startMin` / `durationMinutes`), so the week grid's layout maths does not
 * need to know this kind exists.
 */
export function commitmentsOn(state, iso) {
  const all = live(state.commitments);
  if (!all.length) return [];
  const date = parseLocalDate(iso);
  if (!date || Number.isNaN(date.getTime())) return [];
  const weekday = date.getDay();

  const out = [];
  for (const c of all) {
    if (!occursOn(c, iso, weekday)) continue;
    const startMin = timeToMinutes(c.startTime);
    const endMin = timeToMinutes(c.endTime);
    // A row that fails either parse, or whose end is not after its start, is
    // dropped rather than clamped — clamping would invent a duration the user
    // never entered and then draw it as fact.
    if (startMin === null || endMin === null || endMin <= startMin) continue;
    out.push({
      kind: 'commitment',
      id: c.id,
      // The occurrence needs an identity distinct from the row: one weekly
      // commitment produces many blocks, and React keys them per day.
      occurrenceId: `${c.id}@${iso}`,
      iso,
      title: c.title,
      color: c.color || null,
      notes: c.notes || '',
      weekly: isWeekly(c),
      startMin,
      endMin,
      durationMinutes: endMin - startMin,
      source: c,
    });
  }
  out.sort((a, b) => (a.startMin - b.startMin) || String(a.title || '').localeCompare(String(b.title || '')));
  return out;
}

/** Total committed minutes on `iso` — what the day has already spent before
 *  any studying is planned into it. */
export function committedMinutesOn(state, iso) {
  return commitmentsOn(state, iso).reduce((n, c) => n + c.durationMinutes, 0);
}

/** The next date on or after `from` that a weekly commitment lands on, so the
 *  editor can say what "every Tuesday" actually means for this row. Returns
 *  null for a one-off (its date is already explicit) or when the rule has
 *  already ended. */
export function nextOccurrence(c, fromIso) {
  if (!c || !isWeekly(c)) return null;
  const start = c.startsOn > fromIso ? c.startsOn : fromIso;
  const d = parseLocalDate(start);
  if (!d || Number.isNaN(d.getTime())) return null;
  // At most seven steps: one of them is the right weekday by definition.
  for (let i = 0; i < 7; i++) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (occursOn(c, iso, d.getDay())) return iso;
    d.setDate(d.getDate() + 1);
  }
  return null;
}
