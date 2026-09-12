// v1.14 Item 3 (#51) — which Plan sections are folded shut.
//
//   > "in the LIST section it would be great if you could minimize the
//      sections by clicking on them"
//
// The Plan tab is one long column: three sections, and the middle one carries a
// month grid AND a 60-day agenda AND the exam cards. A student who came to tick
// off an assignment scrolls past all of it. Folding a section is the cheapest
// possible answer and it needs no schema: this is a view preference, in the
// same class as the week-start override and the day boundary next to it, and
// like those it lives in localStorage. Cross-device sync would mean a column, a
// migration and a write on every tap, to carry the fact that someone prefers
// their exam calendar shut.
//
// STORED AS "WHICH ARE CLOSED", not "which are open", so the absent value — a
// fresh install, a cleared cache, a read that throws in private mode — is the
// behaviour every existing user already has. Nothing folds itself.

const KEY = 'studydesk-plan-collapsed';

/** The foldable sections, in the order they appear on the tab. */
export const PLAN_SECTIONS = ['assignments', 'exams', 'courses'];

/** `{ assignments: bool, exams: bool, courses: bool }` — true means folded. */
export function readCollapsed() {
  const out = {};
  for (const id of PLAN_SECTIONS) out[id] = false;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const saved = JSON.parse(raw);
    // A hand-edited or half-written value must not blank the tab, so each key
    // is read independently and anything unrecognised stays open.
    if (saved && typeof saved === 'object') {
      for (const id of PLAN_SECTIONS) out[id] = saved[id] === true;
    }
  } catch {
    /* private mode, or a corrupt value — everything open is a fine answer */
  }
  return out;
}

export function writeCollapsed(map) {
  try {
    const closed = PLAN_SECTIONS.filter((id) => map?.[id] === true);
    // Nothing folded writes nothing, so the key only exists for people who
    // actually use the feature.
    if (closed.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(closed.map((id) => [id, true]))));
  } catch {
    /* the fold just won't survive a relaunch */
  }
}
