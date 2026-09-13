// v1.14 Item 7a (#51) — planned study blocks that repeat.
//
//   > "planned study sessions can't repeat, only the blockers can"
//
// ── WHY THIS IS NOT THE SAME PROBLEM AS ITEM 7b ──────────────────────────
//
// Blockers recur by RULE: one row says "every other Thursday" and the calendar
// works out which Thursdays. That worked because a blocker has no per-occurrence
// state — there is nothing to record about last Thursday's training beyond that
// it was on.
//
// A planned session has exactly that state and it is the whole point of the
// feature. You either DO one — which writes a `study_sessions` row and links it
// back through `fulfilled_by` — or you dismiss it. A rule-based recurrence
// therefore needs somewhere to hang "this instance was done, that one was
// skipped, this one moved to Friday", which means a template table plus an
// exceptions table, and every read path in the calendar learning about both.
// That is where calendar apps go to die.
//
// ── SO: MATERIALISE FORWARD, ONCE, AT CREATION ───────────────────────────
//
// A repeating plan writes N ordinary `planned_sessions` rows up front. Each one
// is a completely normal plan: it syncs, it is dragged, it is logged, it is
// dismissed, all through paths that already exist and already work. No new
// concepts, and nothing new that can break.
//
// Volume is a non-issue. `planned_sessions` held 5 rows across the whole
// project when this was written; a daily plan for a term is about 90.
//
// ── AND DELIBERATELY NO TOP-UP ───────────────────────────────────────────
//
// The obvious next thought is a background job that extends the series as the
// horizon approaches. It is not here on purpose. It would be a write path that
// creates rows nobody asked for, at a moment nobody is watching, and the
// failure mode — silently filling somebody's calendar — is worse than the thing
// it fixes.
//
// Instead the horizon is the END OF THE TERM the plan starts in, and the editor
// says which date that is before you commit. A study plan only means anything
// inside a term anyway: "revise Tuesdays at six, this term" is the real
// request, and when the term ends the plan should end with it. A plan started
// outside any term gets twelve weeks, which is a term-shaped answer to a
// question with no term in it.

import { parseLocalDate, toLocalISO } from './dates.js';
import { termIndex, resolveTermRange } from './timetable.js';

/** Weeks between occurrences, offered in the editor. Matches the blocker
 *  intervals from Item 7b so the two controls answer the same question the
 *  same way. */
export const REPEAT_WEEK_CHOICES = [1, 2, 3, 4];

/** When no term contains the start date. Twelve weeks is a term-shaped answer
 *  to a question with no term in it. */
export const DEFAULT_HORIZON_WEEKS = 12;

/**
 * A hard stop, independent of the horizon.
 *
 * The horizon is computed from user data — a term's end date — and a term with
 * a typo in it ("ends 2126") would otherwise mint a hundred thousand rows into
 * somebody's calendar in one tap. Weekly for a year is comfortably above any
 * real plan and comfortably below anything that hurts.
 */
export const MAX_OCCURRENCES = 60;

/** `iso` + `n` days, as a local date string. Via the date parts rather than by
 *  adding milliseconds: a DST transition makes a local day 23 or 25 hours long,
 *  and a fortnightly plan crossing one would drift onto the wrong weekday. */
function addDaysIso(iso, n) {
  const d = parseLocalDate(iso);
  if (!d || Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  return toLocalISO(d);
}

/**
 * The last date a plan starting on `startIso` should repeat to.
 *
 * The most specific term containing that date wins — a jakso over the semester
 * containing it, the semester over the year — because that is the smallest
 * period the user has said is a unit, and it is the same specificity rule
 * `lessonsOn` already applies to timetables.
 *
 * @returns {string} a local `YYYY-MM-DD`
 */
export function repeatHorizon(startIso, terms) {
  const byId = termIndex(terms);
  let best = null;
  let bestRank = -1;
  for (const term of byId.values()) {
    const range = resolveTermRange(term, byId);
    if (!range?.from || !range?.to) continue;
    if (startIso < range.from || startIso > range.to) continue;
    // A term nested deeper is more specific. `ancestry` would give the same
    // answer; counting parents is enough and needs no second import.
    let depth = 0;
    for (let t = term; t?.parentId && depth < 8; depth += 1) t = byId.get(t.parentId);
    if (depth > bestRank) { bestRank = depth; best = range.to; }
  }
  return best || addDaysIso(startIso, DEFAULT_HORIZON_WEEKS * 7) || startIso;
}

/**
 * The dates a repeating plan should occupy, first one included.
 *
 * @param {string} startIso      local `YYYY-MM-DD` of the first block
 * @param {number} intervalWeeks 1 = weekly, 2 = fortnightly, …
 * @param {string} untilIso      inclusive last date, from `repeatHorizon`
 * @returns {string[]} always at least the start date, so a caller that asks
 *          for a repeat it cannot honour still gets the block the user drew.
 */
export function occurrenceDates(startIso, intervalWeeks, untilIso) {
  if (!startIso) return [];
  const every = Math.round(Number(intervalWeeks));
  if (!Number.isFinite(every) || every < 1) return [startIso];

  const out = [startIso];
  let cursor = startIso;
  while (out.length < MAX_OCCURRENCES) {
    const next = addDaysIso(cursor, every * 7);
    // A date that will not parse stops the series rather than looping: the
    // alternative is an infinite `while` in a click handler.
    if (!next) break;
    if (untilIso && next > untilIso) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * The other occurrences of a repeating plan that it is safe to remove.
 *
 * "Safe" excludes anything already resolved. A block you LOGGED is the
 * `fulfilled_by` pointer to a real `study_sessions` row — deleting it would
 * orphan evidence of study that actually happened, to tidy up an intention.
 * A dismissed one is a decision the user already made and does not need
 * revisiting. And only forward: this is "stop repeating", not "erase history".
 */
export function laterInSeries(plannedSessions, seriesId, fromStartsAt) {
  if (!seriesId) return [];
  return (plannedSessions || []).filter((p) => (
    p
    && !p.deletedAt
    && p.seriesId === seriesId
    && !p.fulfilledBy
    && !p.dismissedAt
    && String(p.startsAt) >= String(fromStartsAt)
  ));
}
