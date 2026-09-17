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
//   weekday !== null  ->  every `intervalWeeks` weeks from `startsOn` until
//                         `endsOn` (or open); null interval means every week
// A full recurrence grammar (RRULE, monthly-by-nth) is still deliberately not
// adopted.
//
// v1.14 Item 7b (#51) added the interval. The original note here said "every
// other Thursday" was one of the shapes not worth the machinery; the user
// asked for it directly — "I have obligations that are every 2 weeks" — and it
// turned out not to be machinery at all, just one integer and one modulo.
//
// ── WHY AN INTERVAL, WHEN LESSONS USE A PARITY ───────────────────────────
//
// `timetable_entries.week_parity` is odd/even, counted from the TERM's start,
// and that is right for a lesson: a lesson belongs to a term, and a student
// says "week A / week B" meaning of the term. Copying it here would be wrong
// twice over. A commitment belongs to no term, so there would be nothing to
// anchor the parity to; and a parity cannot say "every third week", which a
// shift rota routinely is.
//
// So a commitment counts from ITS OWN first occurrence — which is the thing
// the user is looking at when they create it — and stores how many weeks
// apart, not which half of a pair it is in.
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

/** Offered in the editor. Past a month the recurrence stops being something a
 *  person keeps in their head, and a one-off is the better answer. */
export const INTERVAL_CHOICES = [1, 2, 3, 4];

/**
 * How many weeks apart, as a usable number.
 *
 * Null, absent, junk and 1 all mean EVERY WEEK — which is what every row
 * written before this column existed means, so there is no backfill and an app
 * version that predates it shows the commitment every week. That degradation
 * is deliberate and it is the safe direction: a user on an old build sees a
 * blocker on a week it is not on, and plans around time they turn out to have,
 * rather than planning study into a training session.
 */
export function intervalWeeks(c) {
  const n = Math.round(Number(c?.intervalWeeks));
  if (!Number.isFinite(n) || n < 1) return 1;
  // Clamped rather than rejected: a hand-edited 99 should behave like the
  // longest interval the app can express, not like an invalid row that
  // vanishes from the calendar.
  return Math.min(n, INTERVAL_CHOICES[INTERVAL_CHOICES.length - 1]);
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`.
 *
 *  Via `Date.UTC`, which has no DST, so a span crossing a transition is still
 *  a whole number of days. `weekParityOf` documents the same hazard for
 *  lessons; here a one-hour error across a 26-week term would be enough to
 *  drop or duplicate an occurrence. */
function daysBetween(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  if (![ay, am, ad, by, bm, bd].every(Number.isFinite)) return null;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * The date of the first occurrence — the anchor every later one counts from.
 *
 * NOT `startsOn` itself. "Every other Thursday from the 15th" where the 15th
 * is a Tuesday means the 17th, then the 31st. Counting from the 15th would put
 * the interval half a week out of phase and silently pick the wrong Thursdays.
 */
export function firstOccurrence(c) {
  if (!c?.startsOn) return null;
  const start = parseLocalDate(c.startsOn);
  if (!start || Number.isNaN(start.getTime())) return null;
  if (!isWeekly(c)) return c.startsOn;
  const shift = (Number(c.weekday) - start.getDay() + 7) % 7;
  start.setDate(start.getDate() + shift);
  const pad = (n) => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
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

  // v1.14 Item 7b. Every week is the overwhelmingly common case and costs
  // nothing to answer, so it returns before any arithmetic happens.
  const every = intervalWeeks(c);
  if (every === 1) return true;
  const anchor = firstOccurrence(c);
  // An anchor we cannot compute means the start date is unreadable. SHOW the
  // blocker — the same rule `entryRunsOnParity` states for an unknown lesson
  // parity, and for the same reason: a student who plans study into a training
  // session is worse off than one who sees a blocker on a free week.
  if (!anchor) return true;
  if (iso < anchor) return false;
  const days = daysBetween(anchor, iso);
  // Both dates are on the same weekday, so this is always a whole number of
  // weeks. A non-multiple means one of them failed to parse, and showing the
  // blocker is the safer answer than hiding it.
  if (days === null || days % 7 !== 0) return true;
  return (days / 7) % every === 0;
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
