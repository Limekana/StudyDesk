// v1.14 — the funnel gap, from usage data rather than a filed issue.
//
//   171 users have created a subject.
//    21 have ever built a timetable.
//    29 have ever logged a study session.
//    20 have ever entered a grade.
//
// Adding a course is the one thing almost everyone does. The three things the
// app is actually FOR are done by roughly one user in seven. Nothing is
// broken — the tabs are right there — but a new user adds a course, lands on
// a screen with no next step on it, and the three features never get a first
// use.
//
// ── WHY THIS IS NOT A WIZARD ─────────────────────────────────────────────
//
// A blocking first-run flow would move these numbers and cost more than it
// earns: StudyDesk's whole posture is to get out of the way, it already has
// an onboarding flow the user has just finished, and a second one stapled to
// "you created a course" would read as a demand. These are inline, skippable
// and individually dismissible — a suggestion in the place the user already
// is, not a gate in front of it.
//
// ── AND WHY IT HAS TO SWITCH ITSELF OFF ──────────────────────────────────
//
// The obvious implementation — "show it whenever the user has none of X" —
// nags the wrong person forever. Someone two years in with four hundred study
// sessions and no timetable is not a user who failed to find the timetable;
// they are a user who does not want one, and telling them to add one every
// time they open the app is the app being wrong at them repeatedly.
//
// So a step is offered only while the user still looks NEW: they have done at
// most one of the three. Someone at two-of-three has found their way around
// and the third is a choice. That rule needs no timestamps, no install date
// and no server flag, and it extinguishes itself — which matters, because
// nobody will remember to come back and turn this off.

const KEY = 'studydesk-first-steps-dismissed';

/** In the order they are offered. Timetable first because it is the one with
 *  the worst conversion and the one the other two hang off: a lesson grid is
 *  what makes "log a session" and "enter a grade" have somewhere to land. */
export const FIRST_STEPS = ['timetable', 'session', 'grade'];

/** Above this many of the three already done, the user is not new and the
 *  remaining one is a preference rather than a gap. */
export const NEW_USER_MAX_DONE = 1;

function nonEmpty(v) {
  if (Array.isArray(v)) return v.some((x) => x && !x.deletedAt);
  if (v && typeof v === 'object') return Object.values(v).some((x) => x && !x.deletedAt);
  return false;
}

/**
 * Which of the three the user has actually done.
 * Kept separate from `outstandingSteps` so the "is this user new" test and
 * the "what is left" question read from one source and cannot disagree.
 */
export function stepsDone(state) {
  return {
    timetable: nonEmpty(state?.timetableEntries),
    session: nonEmpty(state?.studySessions),
    grade: nonEmpty(state?.grades),
  };
}

export function readDismissed() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(raw) ? raw.filter((s) => FIRST_STEPS.includes(s)) : [];
  } catch {
    // Unreadable means nothing has been dismissed, which shows the prompts.
    // The alternative default — hide everything — would turn one corrupt key
    // into a feature that silently never appears again.
    return [];
  }
}

export function dismissStep(step, current = readDismissed()) {
  const next = [...new Set([...current, step])].filter((s) => FIRST_STEPS.includes(s));
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode — the dismissal just won't survive a relaunch */
  }
  return next;
}

/**
 * The steps to offer right now.
 *
 * @param {object} state     the app state
 * @param {string[]} dismissed
 * @returns {string[]} in FIRST_STEPS order, possibly empty
 *
 * Empty when: the user has no course yet (there is an earlier prompt for
 * that, and suggesting a timetable with nothing to put on it is noise), when
 * every step is done, or when the user is past NEW_USER_MAX_DONE.
 */
export function outstandingSteps(state, dismissed = readDismissed()) {
  if (!nonEmpty(state?.courses)) return [];
  const done = stepsDone(state);
  const doneCount = FIRST_STEPS.filter((s) => done[s]).length;
  if (doneCount > NEW_USER_MAX_DONE) return [];
  const skip = new Set(dismissed || []);
  return FIRST_STEPS.filter((s) => !done[s] && !skip.has(s));
}
