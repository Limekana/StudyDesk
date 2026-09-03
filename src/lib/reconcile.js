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
  // v1.13 Item 1a — see the study-session block below for why these were
  // missing and why that mattered more than the four above.
  const remoteSessions = remoteIds(remote?.sessions);
  const remotePlanned = remoteIds(remote?.plannedSessions);
  const remoteTerms = remoteIds(remote?.academicTerms);
  const remoteTimetable = remoteIds(remote?.timetableEntries);
  const remoteCommitments = remoteIds(remote?.commitments);
  const remoteNotes = remoteIds(remote?.notes);

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

  // ── v1.13 Item 1a — study sessions ───────────────────────────────────────
  //
  // **This table was excluded from the v1.12 repair, and it is the one the
  // reported loss was in.**
  //
  // The v1.12 note said the remaining tables "either carry ON DELETE SET NULL
  // (so they cannot produce the FK failure) or have no reported loss." Both
  // halves are about issue #38, which is a FOREIGN KEY failure — and reasoning
  // from that symptom is what excluded study_sessions, because a nullable
  // subject_id genuinely cannot produce it.
  //
  // But the module's own header already gives the wider justification:
  // converging on STATE rather than replaying EVENTS repairs any loss that
  // leaves a row local-only, whatever caused it. Judged against that, the
  // exclusion had it backwards. Sessions cannot throw the FK error, so nothing
  // ever surfaced them as stuck; they simply stayed local and silent — and
  // there WAS a reported loss:
  //
  //   > "Offline sessions never synced; an app update then destroyed them.
  //      Five hours of logged study, gone from every device."   (`1cab0fb7`)
  //
  // Same account, five days later, reported that manual logging saved nothing
  // either (the 1.12.1 H1 hotfix). One person, failed twice through the same
  // gap, and this half of it was still open.
  //
  // A session with no course is legitimate — the timer can run unassigned —
  // so "no parent" and "parent missing" are different answers here and only
  // the second is a reason to hold the row back.
  for (const ss of state?.studySessions || []) {
    if (!ss?.id || ss.deletedAt || remoteSessions.has(ss.id)) continue;
    const linked = ss.subjectId ?? ss.courseId ?? null;
    if (linked && !parentWillExist(linked)) continue;
    out.push({
      kind: 'log_session',
      payload: {
        id: ss.id,
        subjectId: linked,
        startedAt: ss.startedAt,
        durationMinutes: ss.durationMinutes,
        notes: ss.notes,
        focusRating: ss.focusRating,
        aiDebriefRaw: ss.aiDebriefRaw,
        aiSubjectCovered: ss.aiSubjectCovered,
        aiComprehension: ss.aiComprehension,
        aiConfusionFlags: ss.aiConfusionFlags,
        aiSessionSummary: ss.aiSessionSummary,
      },
    });
  }

  // ── The term tree, and what hangs off it ─────────────────────────────────
  //
  // Terms are their own parent chain (a jakso hangs off a semester hangs off a
  // school year), so a term whose PARENT term is also local-only has to go in
  // the same batch or its FK fails for real. `upsert_term` is rank 0 in the
  // outbox and reconcile emits in array order, so ordering holds as long as
  // the local list is itself ordered parent-first — which the term editor
  // guarantees, since a child cannot be created before its parent exists.
  const pushedTerms = new Set();
  for (const tm of state?.academicTerms || []) {
    if (!tm?.id || tm.deletedAt || remoteTerms.has(tm.id)) continue;
    pushedTerms.add(tm.id);
    out.push({
      kind: 'upsert_term',
      payload: {
        id: tm.id,
        parentId: tm.parentId,
        level: tm.level,
        name: tm.name,
        startsOn: tm.startsOn,
        endsOn: tm.endsOn,
        position: tm.position,
      },
    });
  }
  const termWillExist = (id) => !id || remoteTerms.has(id) || pushedTerms.has(id);

  for (const te of state?.timetableEntries || []) {
    if (!te?.id || te.deletedAt || remoteTimetable.has(te.id)) continue;
    // Two parents, and both have to hold.
    if (!termWillExist(te.termId)) continue;
    if (te.subjectId && !parentWillExist(te.subjectId)) continue;
    out.push({
      kind: 'upsert_timetable',
      payload: {
        id: te.id,
        termId: te.termId,
        subjectId: te.subjectId,
        title: te.title,
        weekday: te.weekday,
        startsAt: te.startsAt,
        endsAt: te.endsAt,
        room: te.room,
        color: te.color,
      },
    });
  }

  // Planned blocks are intentions, not evidence — they must never become a
  // study_sessions row (NEXUS_V19_BUILD_PLAN Item 14a). Pushing them through
  // their own kind keeps that separation: `upsert_planned` writes
  // planned_sessions and touches nothing else.
  for (const ps of state?.plannedSessions || []) {
    if (!ps?.id || ps.deletedAt || remotePlanned.has(ps.id)) continue;
    if (ps.subjectId && !parentWillExist(ps.subjectId)) continue;
    out.push({
      kind: 'upsert_planned',
      payload: {
        id: ps.id,
        subjectId: ps.subjectId,
        startsAt: ps.startsAt,
        durationMinutes: ps.durationMinutes,
        title: ps.title,
        notes: ps.notes,
        fulfilledBy: ps.fulfilledBy,
        dismissedAt: ps.dismissedAt,
      },
    });
  }

  // Commitments have no parent at all — training, clubs, shifts are not
  // attached to a course — so there is no guard to apply.
  for (const cm of state?.commitments || []) {
    if (!cm?.id || cm.deletedAt || remoteCommitments.has(cm.id)) continue;
    out.push({
      kind: 'upsert_commitment',
      payload: {
        id: cm.id,
        title: cm.title,
        color: cm.color,
        weekday: cm.weekday,
        startsOn: cm.startsOn,
        endsOn: cm.endsOn,
        startTime: cm.startTime,
        endTime: cm.endTime,
        notes: cm.notes,
      },
    });
  }

  // ── v1.13 Item 1b — notebook entries ─────────────────────────────────────
  //
  // In from the start rather than added after the first loss report. The
  // build plan's argument for shipping durability BEFORE the notebook is
  // exactly this: "Notes are far more precious to a student than session
  // logs, so putting a notebook on that storage layer means the next
  // data-loss report is somebody's exam revision rather than their timer
  // history."
  //
  // `course_id` is nullable and `ON DELETE SET NULL`, so an unfiled note and
  // a note whose course was deleted are both legitimate and neither is a
  // reason to hold it back. Only a course that is about to exist nowhere is.
  for (const n of state?.notes || []) {
    if (!n?.id || n.deletedAt || remoteNotes.has(n.id)) continue;
    if (n.courseId && !parentWillExist(n.courseId)) continue;
    out.push({
      kind: 'upsert_note',
      payload: {
        id: n.id,
        courseId: n.courseId,
        title: n.title,
        lessonDate: n.lessonDate,
        content: n.content,
        // Deliberately dropped when the session is not on the server: the
        // note is worth far more than its session link, and an FK to a
        // session that never synced would fail the whole upsert. The link is
        // a nicety; the writing is the point.
        sessionId: n.sessionId && remoteIds(remote?.sessions).has(n.sessionId) ? n.sessionId : null,
      },
    });
  }

  return out;
}

/**
 * Enqueue everything `findUnsynced` turns up. Returns the number queued so the
 * caller can report it.
 *
 * v1.13 Item 1a widened this from the four `subjects` foreign-key tables that
 * issue #38 named to every table that can hold a local-only row:
 * `study_sessions`, `academic_terms`, `timetable_entries`, `planned_sessions`
 * and `commitments` are now repaired too.
 *
 * The narrower scope was chosen because #38 presents as a FOREIGN KEY error,
 * and the excluded tables cannot throw one. That is true and it is the wrong
 * test: a row that fails loudly at least gets noticed, while a row that stays
 * local-only in silence is the shape that lost somebody five hours of study.
 *
 * `study_actions` remains out, and this one IS deliberate: only manual to-dos
 * live in `state.actions`, the Actions view derives its suggestions at render
 * time, and `applyRemotePull` already removes actions by tombstone rather than
 * keeping them — so a local-only action is a to-do the user can see and
 * re-create, not silent loss of recorded work. Attachments are out for the
 * reason `KIND_DISPATCH` gives: a File cannot survive the queue's JSON round
 * trip, so an upload has to be online and reports its own failure.
 */
export function reconcileUnsynced(state, remote, outbox) {
  const items = findUnsynced(state, remote);
  for (const { kind, payload } of items) outbox.enqueue(kind, payload);
  return items.length;
}
