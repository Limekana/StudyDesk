// The draft a hand-logged study session opens with (#33, v1.12).
//
// Shared by the two places that offer "Log a past session": the button under
// the timer, and (v1.15 Item 6) the Log list, which is where somebody looking
// for their sessions actually is. One draft so the two entry points cannot
// open the sheet with different defaults.
//
// It goes through the same SaveSessionSheet and the same ADD_SESSION write a
// timer-completed block does, so a manual session is indistinguishable
// downstream. That is the point: NCC's Life Score must not treat it as lesser.
//
// Starts an hour ago rather than now, because a session you are logging by hand
// already happened; `allowDateEdit` turns the read-only start into a field.
export function pastSessionDraft(subjectId = null) {
  return {
    durationMinutes: 30,
    task: '',
    subjectId: subjectId || null,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    allowDateEdit: true,
  };
}
