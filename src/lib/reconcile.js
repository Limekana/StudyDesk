// ── Local-only row reconciliation ──────────────────────────────────────────
//
// v1.12 Item 1, issue #38.
//
// **The defect this exists to close.** Every `outbox.enqueue` call site in the
// app is gated on `if (session)`. A mutation made while `session` is null is
// therefore not queued — it is *dropped*, silently and permanently. Nothing in
// the app ever re-pushes it: `pullAllStudyData` is pull-only, and the diff
// pusher in `App.jsx` re-pushes a row only when it changes again, against a
// baseline recorded after the pull. A row created in a session-null window and
// never touched afterwards stays local forever.
//
// `session` is null more often than the gating implies:
//   * **Every cold start**, until `adoptSession()` resolves — a second or two,
//     on every single launch.
//   * **`SESS-1`**, the daily forced sign-out, for *hours* at a time. It was
//     live across the entire history of every current user and was only fixed
//     in `v1.11`.
//
// **Why that produces a foreign-key error rather than just a missing row.**
// The parent and the child are created in different moments. A course created
// during a session-null window is dropped; the exam added to it a day later,
// with a session, is queued normally — against a `subject_id` the server has
// never seen. `exams_subject_id_fkey` then fails on every drain, forever.
// That is issue #38, and no user action could fix it: "Retry now" re-drains
// the same doomed item and "Pull latest now" only pulls.
//
// **Why fixing the gates alone would not have been enough.** `v1.11` fixed
// `SESS-1`, which stops *new* orphans. It does nothing for rows already
// stranded — which is exactly why the reporter is still broken after it. The
// queue cannot heal itself, so something has to notice the divergence and
// re-push. That is this module.
//
// Converging on *state* rather than replaying *events* also covers losses this
// module was not written for: a crash between dispatch and enqueue, a
// quota-exceeded `saveItems`, an app reinstall that wipes the queue. Anything
// that leaves a row local-only is repaired on the next pull.

/**
 * Rows present locally but absent from the server, ready to enqueue.
 *
 * @param {object} state   The app reducer state (`courses` map + entity arrays).
 * @param {object} remote  The result of `sync.pullAllStudyData()`.
 * @returns {Array<{kind: string, payload: object}>}
 */
export function findUnsynced(state, remote) {
  // Compare against EVERY remote row, including soft-deleted ones. A course
  // the user deleted on another device comes back from the pull carrying its
  // `deleted_at` tombstone, so it is present here and correctly skipped.
  // Comparing against live rows only would resurrect deleted courses on every
  // pull — the one way this repair could actively damage data.
  const remoteIds = (rows) => new Set((rows || []).map((r) => r.id));

  const remoteSubjects = remoteIds(remote?.subjects);
  const remoteExams = remoteIds(remote?.exams);
  const remoteAssignments = remoteIds(remote?.assignments);
  const remoteGrades = remoteIds(remote?.grades);

  const out = [];

  // ── Parents first ────────────────────────────────────────────────────────
  // Not for ordering — `outbox.drain` handles that by rank — but because the
  // child passes below consult this set to avoid queueing a child whose parent
  // cannot exist.
  const courses = Object.values(state?.courses || {}).filter(Boolean);
  const pushedSubjects = new Set();
  for (const c of courses) {
    if (!c.id || c.deletedAt || remoteSubjects.has(c.id)) continue;
    pushedSubjects.add(c.id);
    out.push({
      kind: 'upsert_subject',
      payload: {
        id: c.id,
        name: c.name,
        credits: c.credits,
        semester: c.semester,
        schoolYear: c.schoolYear,
        color: c.color,
      },
    });
  }

  // A child is safe to push only if its parent is already on the server or is
  // being pushed in this same batch. Queueing a child whose course was deleted
  // locally would manufacture exactly the poison item this module exists to
  // clear — the repair must not become a new source of the bug.
  const parentWillExist = (id) => !!id && (remoteSubjects.has(id) || pushedSubjects.has(id));

  for (const e of state?.exams || []) {
    if (!e?.id || e.deletedAt || remoteExams.has(e.id)) continue;
    if (!parentWillExist(e.courseId)) continue;
    out.push({
      kind: 'upsert_exam',
      payload: {
        id: e.id,
        courseId: e.courseId,
        title: e.title,
        dueDate: e.dueDate,
        difficulty: e.difficulty,
        notes: e.notes,
        done: e.done,
        topics: e.topics,
      },
    });
  }

  for (const a of state?.assignments || []) {
    if (!a?.id || a.deletedAt || remoteAssignments.has(a.id)) continue;
    if (!parentWillExist(a.courseId)) continue;
    out.push({
      kind: 'upsert_assignment',
      payload: {
        id: a.id,
        courseId: a.courseId,
        title: a.title,
        type: a.type,
        dueDate: a.dueDate,
        notes: a.notes,
        done: a.done,
      },
    });
  }

  for (const g of state?.grades || []) {
    if (!g?.id || g.deletedAt || remoteGrades.has(g.id)) continue;
    if (!parentWillExist(g.subjectId)) continue;
    out.push({
      kind: 'upsert_grade',
      payload: {
        id: g.id,
        subjectId: g.subjectId,
        grade: g.grade,
        weight: g.weight,
        date: g.date,
      },
    });
  }

  return out;
}

/**
 * Enqueue everything `findUnsynced` turns up. Returns the number queued so the
 * caller can report it.
 *
 * Deliberately scoped to the four tables in the `subjects` foreign-key family
 * — the ones issue #38 names. `planned_sessions`, `academic_terms`,
 * `timetable_entries`, `study_actions`, `commitments` and `study_sessions` are
 * exposed to the same dropped-write defect and are NOT repaired here; they
 * either carry `ON DELETE SET NULL` (so they cannot produce the FK failure) or
 * have no reported loss. Adding a kind is a block of the same shape above.
 */
export function reconcileUnsynced(state, remote, outbox) {
  const items = findUnsynced(state, remote);
  for (const { kind, payload } of items) outbox.enqueue(kind, payload);
  return items.length;
}
