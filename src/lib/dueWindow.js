// v1.14 Item 4 (#51) — what "due" means on a course card's red badge.
//
//   > "the number of assignments due is counted for the whole semester […] if
//      you have put in all your assignments for the semester it says you have
//      like 20 assignments due which looks kind of alarming"
//
// The badge counted every open assignment with a due date, however far off, and
// then coloured itself red. For a student who filled in the whole term up front
// — exactly the diligent behaviour the Plan tab is asking for — the reward was
// a screen that says twenty things are due. The count was never wrong; the word
// was. "Open" and "due" are different claims and the badge was making the
// second one with the first one's number.
//
// So this is a display computation, not a data change: nothing about an
// assignment changes, only which ones the badge is willing to call due.
//
// WHY A HORIZON PER TYPE, by default. A reading set for Friday is due in the
// sense that matters on a Tuesday; an essay due in ten days is also due, in the
// sense that you should have started. One number cannot be right for both, and
// the issue's own framing ("readings within a few days, essays and exams a
// couple of weeks") is a per-type answer. `smart` is that answer; the fixed
// horizons are there for anyone who disagrees, and `all` is the behaviour
// before this change for anyone who preferred it.
//
// DEVICE-LOCAL, like the day boundary and the week-start override it sits
// beside in Settings — it decides how a number is rendered, not what is stored,
// and so needs no column, no migration and no sync.

const KEY = 'studydesk-due-window';

/** Per-type horizons for `smart`, in days. */
const SMART_DAYS = { Reading: 3 };
/** Everything not named above — essays, problem sets, labs, projects, exams,
 *  quizzes, and any free-text type someone typed under "Other". */
const SMART_DEFAULT_DAYS = 14;

/** The default. Nothing here is destructive, so unlike the day boundary this
 *  one does move existing users' numbers — which is the point of the item. */
export const DEFAULT_DUE_WINDOW = 'smart';

/** Offered in Settings, in this order. `all` last: it is the escape hatch, not
 *  a recommendation. */
export const DUE_WINDOW_CHOICES = ['smart', 3, 7, 14, 30, 'all'];

function normalize(value) {
  if (value === 'all' || value === 'smart') return value;
  const n = Number(value);
  return DUE_WINDOW_CHOICES.includes(n) ? n : DEFAULT_DUE_WINDOW;
}

export function preferredDueWindow() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? DEFAULT_DUE_WINDOW : normalize(raw);
  } catch {
    return DEFAULT_DUE_WINDOW;
  }
}

export function setPreferredDueWindow(value) {
  try {
    const v = normalize(value);
    if (v === DEFAULT_DUE_WINDOW) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(v));
  } catch {
    /* private mode — the choice just won't survive a relaunch */
  }
}

/** The horizon, in days, that `window` applies to an item of `type`. */
export function horizonFor(type, window = DEFAULT_DUE_WINDOW) {
  if (window === 'all') return Infinity;
  if (window === 'smart') {
    return Object.prototype.hasOwnProperty.call(SMART_DAYS, type)
      ? SMART_DAYS[type]
      : SMART_DEFAULT_DAYS;
  }
  return window;
}

/**
 * Does an item count toward the "N due" badge?
 *
 * @param {number|null} daysLeft  days from today to the due date; negative is
 *                                overdue, null is "no due date set"
 * @param {string}      type      the assignment type, or undefined for an exam
 * @param {string|number} window  the user's preference
 *
 * An item with no due date is NOT due — it was counted before this change, and
 * counting something whose date nobody has decided is the clearest case of the
 * badge overstating itself. It stays visible in the list either way.
 *
 * Overdue always counts, at every setting including a 3-day horizon: something
 * you have missed is the one thing a badge must never quietly stop mentioning.
 */
export function countsAsDue(daysLeft, type, window = DEFAULT_DUE_WINDOW) {
  if (daysLeft === null || daysLeft === undefined) return false;
  if (daysLeft < 0) return true;
  return daysLeft <= horizonFor(type, window);
}
