// ── Which day does a study session belong to? (#54) ────────────────────────
//
// Two separate defects sit behind that question, and the issue reports the
// second as a consequence of the first.
//
// ── 1. The app did not agree with itself ──
//
// Three surfaces bucketed sessions by day and two of them used UTC:
//
//     StatsView   dayKey()  -> LOCAL calendar date          (correct)
//     SessionsView          -> startedAt.slice(0, 10)       (UTC)
//     TimerView             -> startedAt.slice(0, 10)       (UTC)
//
// An ISO string's first ten characters are its UTC date, so west of Greenwich
// every evening session is filed a day late and east of it every early-morning
// one is filed a day early. Measured in a real browser at 21:00 local on the
// 10th, seeded identically in three timezones:
//
//     UTC                  Log tab: TODAY          Stats streak: 4
//     America/Los_Angeles  Log tab: FRIDAY, 11     Stats streak: 4
//     Asia/Tokyo           Log tab: TODAY          Stats streak: 4
//
// The Los Angeles run files tonight's session under TOMORROW, and then labels
// the group with `fmtDateHeader`, which compares against LOCAL today — so the
// list shows a session dated in the future and skips a day that has one. Log a
// past session to fill a gap and this is the screen you check it on.
//
// ── 2. Midnight is not where everyone's day ends ──
//
//   > "I'd suggest adding an option to mark when days end, since its common
//      for people to study during the night. Those sessions, even though they
//      are technically a new day, feel more like the same one."   (#54)
//
// Nothing was wrong with the arithmetic there — 01:00 IS the next day — but a
// streak is a claim about the user's habit, and for a night owl the calendar
// splits one study night across two days and breaks a streak they kept. So the
// boundary is a setting: `dayStartHour` 4 means a session before 04:00 counts
// for the day before.
//
// Both halves are the same fix, which is why they are one module: every
// surface asks THIS for the day of a session, and gets the user's answer.

const DAY_START_KEY = 'studydesk-day-start-hour';

/** Midnight — the calendar answer, and what every existing user has had. */
export const DEFAULT_DAY_START_HOUR = 0;

/** The offered boundaries. Past ~6am a "day" stops being recognisable as one,
 *  and an unbounded number field would invite 23 — which silently relabels
 *  every daytime session as yesterday's. */
export const DAY_START_CHOICES = [0, 1, 2, 3, 4, 5, 6];

function clampHour(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DAY_START_HOUR;
  return Math.min(6, Math.max(0, Math.round(n)));
}

/** The user's chosen boundary, or midnight. Device-local, like the week-start
 *  override it sits next to in Settings: it is a reading preference, and
 *  storing it here needs no column, no migration and no sync. */
export function preferredDayStart() {
  try {
    const raw = localStorage.getItem(DAY_START_KEY);
    return raw === null ? DEFAULT_DAY_START_HOUR : clampHour(raw);
  } catch {
    return DEFAULT_DAY_START_HOUR;
  }
}

export function setPreferredDayStart(hour) {
  try {
    const h = clampHour(hour);
    if (h === DEFAULT_DAY_START_HOUR) localStorage.removeItem(DAY_START_KEY);
    else localStorage.setItem(DAY_START_KEY, String(h));
  } catch {
    /* private mode — the choice just won't survive a relaunch */
  }
}

/**
 * The local date, as `YYYY-MM-DD`, of the study day a moment falls in.
 *
 * LOCAL, via the date getters, never `toISOString().slice(0, 10)` — that is
 * the bug at the top of this file. The shift is applied by moving the instant
 * back by `dayStartHour` hours before reading the date, so 01:30 with a 4am
 * boundary reads as the previous day and 04:30 reads as this one.
 *
 * @param {string|number|Date} when
 * @param {number} dayStartHour
 * @returns {string|null} null when `when` is not a usable date
 */
export function studyDayKey(when, dayStartHour = DEFAULT_DAY_START_HOUR) {
  // `new Date(null)` is the epoch, not an invalid date, so a row with no
  // startedAt would otherwise be filed under 1970-01-01 — a real group header,
  // at the bottom of the list, for a row whose day is simply unknown.
  // SessionsView filters only on `deletedAt`, so it does see such rows.
  if (when === null || when === undefined || when === '') return null;
  const d = when instanceof Date ? new Date(when.getTime()) : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  const h = clampHour(dayStartHour);
  if (h) d.setHours(d.getHours() - h);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The study day `now` is in. */
export function todayStudyDayKey(dayStartHour = DEFAULT_DAY_START_HOUR, now = new Date()) {
  return studyDayKey(now, dayStartHour);
}

/**
 * Walk back `n` study days from a key.
 *
 * Done on a local Date built from the key's own parts rather than by
 * subtracting 86400000ms, so a DST transition — which makes a local day 23 or
 * 25 hours long — cannot drop or repeat a day in the middle of a streak.
 *
 * @param {string} key `YYYY-MM-DD`
 * @param {number} n days to subtract
 */
export function shiftDayKey(key, n) {
  const [y, m, d] = String(key).split('-').map(Number);
  const x = new Date(y, (m || 1) - 1, d || 1);
  x.setDate(x.getDate() - n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** A local Date at the start of the calendar day a key names. For formatting
 *  a group header — `new Date('2026-09-11')` alone is parsed as UTC midnight,
 *  which renders as the 10th for anyone west of Greenwich. */
export function dayKeyToDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
