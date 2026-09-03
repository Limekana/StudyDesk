// LWW merge utilities for syncing Supabase rows into the local reducer state.
//
// Convention:
//   - Local entities use camelCase: { id, subjectId, updatedAt, deletedAt, ... }
//   - DB rows use snake_case:       { id, subject_id, updated_at, deleted_at, ... }
// These helpers translate one direction (DB → local) and reconcile via LWW
// using updated_at / updatedAt timestamps.

function newer(remoteIso, localIso) {
  if (!localIso) return true;
  if (!remoteIso) return false;
  // Compare as instants, not raw strings. Local updatedAt is Date.toISOString()
  // (`...sssZ`); remote updated_at is Postgres timestamptz text (`...+00:00`,
  // variable-length fractional seconds, no `Z`). Lexicographic `>` only tracks
  // real order when the date/seconds differ — for two writes in the same second
  // the differing suffix can flip the result and clobber a newer edit.
  return new Date(remoteIso).getTime() > new Date(localIso).getTime();
}

/**
 * DB subject row → local-shaped object.
 *
 * v1.0.3: `color` is now a synced DB column (was local-only in v1.0.2). LWW on
 * the whole row by updated_at — including color. Nexus-Command-Center also
 * writes color, so the newer side wins. If remote color is null and local has
 * one, the local color is preserved (we don't clobber a useful value with null
 * unless the remote row is genuinely newer AND explicitly set color=null).
 *
 * `notes` stays local-only (not a Nexus-known field).
 */
function mergeSubject(localCourse, remoteRow) {
  const remote = {
    id: remoteRow.id,
    name: remoteRow.name,
    credits: remoteRow.credits ?? 1,
    semester: remoteRow.semester ?? null,
    // v1.5 — school_year groups periods for the history view (nullable).
    schoolYear: remoteRow.school_year ?? null,
    color: remoteRow.color || null,
    // v1.2 — archived_at piggybacks on updated_at like every other column.
    // Null means active; ISO string means archived at that moment.
    archivedAt: remoteRow.archived_at || null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localCourse) {
    // New subject discovered remotely — use remote color if set, gray default otherwise.
    return { ...remote, color: remote.color || '#7a7570', notes: [] };
  }
  if (newer(remote.updatedAt, localCourse.updatedAt)) {
    return {
      ...localCourse,
      ...remote,
      // If remote is newer but didn't include a color value, fall back to local
      // (avoids wiping a user's color picker choice just because NCC sent an
      // edit that didn't touch color).
      color: remote.color || localCourse.color,
      notes: localCourse.notes ?? [],
    };
  }
  return localCourse;
}

function mergeGrade(localGrade, remoteRow) {
  const remote = {
    id: remoteRow.id,
    subjectId: remoteRow.subject_id,
    grade: Number(remoteRow.grade),
    weight: remoteRow.weight != null ? Number(remoteRow.weight) : 1,
    date: remoteRow.date || null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localGrade) return remote;
  if (newer(remote.updatedAt, localGrade.updatedAt)) return remote;
  return localGrade;
}

function mergeSession(localSession, remoteRow) {
  const remote = {
    id: remoteRow.id,
    subjectId: remoteRow.subject_id || null,
    startedAt: remoteRow.started_at,
    durationMinutes: remoteRow.duration_minutes,
    notes: remoteRow.notes || null,
    // v1.3 (BUG-22) — focus_rating is nullable; older rows have none.
    focusRating: remoteRow.focus_rating ?? null,
    // v1.4 — AI debrief fields; null on rows logged without a debrief.
    aiDebriefRaw: remoteRow.ai_debrief_raw ?? null,
    aiSubjectCovered: remoteRow.ai_subject_covered ?? null,
    aiComprehension: remoteRow.ai_comprehension ?? null,
    aiConfusionFlags: Array.isArray(remoteRow.ai_confusion_flags) ? remoteRow.ai_confusion_flags : null,
    aiSessionSummary: remoteRow.ai_session_summary ?? null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localSession) return remote;
  if (newer(remote.updatedAt, localSession.updatedAt)) return remote;
  return localSession;
}

// v1.7 (StudyDesk#6) — assignments, exams and manual to-dos. Local shape uses
// `courseId` where the DB says `subject_id`; everything else is a straight
// rename. Same LWW rule as the three above: whole-row replace when remote wins.

function mergeAssignment(localA, remoteRow) {
  const remote = {
    id: remoteRow.id,
    courseId: remoteRow.subject_id,
    title: remoteRow.title,
    type: remoteRow.type || null,
    // The local UI binds these to text inputs, which cannot hold null without
    // React flipping the field to uncontrolled — keep the empty-string shape
    // the reducer already creates.
    dueDate: remoteRow.due_date || '',
    notes: remoteRow.notes || '',
    done: Boolean(remoteRow.done),
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localA) return remote;
  if (newer(remote.updatedAt, localA.updatedAt)) return remote;
  return localA;
}

function mergeExam(localE, remoteRow) {
  const remote = {
    id: remoteRow.id,
    courseId: remoteRow.subject_id,
    title: remoteRow.title,
    dueDate: remoteRow.due_date || '',
    difficulty: remoteRow.difficulty || 'medium',
    notes: remoteRow.notes || '',
    done: Boolean(remoteRow.done),
    // Topics travel as jsonb. Guard the shape — the local UI maps over this
    // unconditionally, so a null from a malformed row would crash the view.
    topics: Array.isArray(remoteRow.topics) ? remoteRow.topics : [],
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localE) return remote;
  if (newer(remote.updatedAt, localE.updatedAt)) return remote;
  return localE;
}

function mergeAction(localA, remoteRow) {
  const remote = {
    id: remoteRow.id,
    courseId: remoteRow.subject_id || null,
    text: remoteRow.text,
    bucket: remoteRow.bucket || 'today',
    done: Boolean(remoteRow.done),
    // Only manually created to-dos are ever pushed, so anything arriving from
    // the cloud is by definition manual. Stamping these explicitly keeps them
    // from being mistaken for the derived suggestions the Actions view
    // computes on every render.
    suggested: false,
    sourceId: null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localA) return remote;
  if (newer(remote.updatedAt, localA.updatedAt)) return remote;
  return localA;
}

// v1.10 — planned sessions, academic terms, the weekly timetable, and
// assignment attachments. All four follow the assignments/exams/actions
// pattern rather than the courses/grades/sessions one: remote deletes drop the
// row locally instead of leaving a tombstone. Same reasoning — every render
// path for these is new and expects a live list, and a tombstone that one call
// site forgets to filter puts a deleted lesson back on someone's timetable.

function mergePlannedSession(localP, remoteRow) {
  const remote = {
    id: remoteRow.id,
    subjectId: remoteRow.subject_id || null,
    startsAt: remoteRow.starts_at,
    durationMinutes: remoteRow.duration_minutes,
    title: remoteRow.title || '',
    notes: remoteRow.notes || '',
    // The link to the study session that actually happened. Null is the normal
    // state — most planned blocks are still owed.
    fulfilledBy: remoteRow.fulfilled_by || null,
    dismissedAt: remoteRow.dismissed_at || null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localP) return remote;
  if (newer(remote.updatedAt, localP.updatedAt)) return remote;
  return localP;
}

function mergeTerm(localT, remoteRow) {
  const remote = {
    id: remoteRow.id,
    parentId: remoteRow.parent_id || null,
    level: remoteRow.level,
    name: remoteRow.name,
    // Bound to date inputs, which cannot hold null without React flipping the
    // field to uncontrolled — same empty-string shape the reducer creates.
    startsOn: remoteRow.starts_on || '',
    endsOn: remoteRow.ends_on || '',
    position: Number(remoteRow.position) || 0,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localT) return remote;
  if (newer(remote.updatedAt, localT.updatedAt)) return remote;
  return localT;
}

function mergeTimetableEntry(localE, remoteRow) {
  const remote = {
    id: remoteRow.id,
    termId: remoteRow.term_id,
    subjectId: remoteRow.subject_id || null,
    title: remoteRow.title || '',
    // smallint over the wire; the weekday comparison in `lessonsOn` is `===`
    // against `Date.getDay()`, so a string "1" would silently match nothing.
    weekday: Number(remoteRow.weekday),
    startsAt: remoteRow.starts_at,
    endsAt: remoteRow.ends_at,
    room: remoteRow.room || '',
    color: remoteRow.color || null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localE) return remote;
  if (newer(remote.updatedAt, localE.updatedAt)) return remote;
  return localE;
}

function mergeAttachment(localA, remoteRow) {
  const remote = {
    id: remoteRow.id,
    assignmentId: remoteRow.assignment_id,
    storagePath: remoteRow.storage_path,
    fileName: remoteRow.file_name,
    mimeType: remoteRow.mime_type || null,
    sizeBytes: remoteRow.size_bytes != null ? Number(remoteRow.size_bytes) : null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localA) return remote;
  if (newer(remote.updatedAt, localA.updatedAt)) return remote;
  return localA;
}

function mergeCommitment(localC, remoteRow) {
  const remote = {
    id: remoteRow.id,
    title: remoteRow.title,
    color: remoteRow.color || null,
    // Null is meaningful here — it is the one-off/weekly switch — so it must
    // survive as null rather than being coerced to 0, which is Sunday.
    weekday: remoteRow.weekday === null || remoteRow.weekday === undefined ? null : Number(remoteRow.weekday),
    startsOn: remoteRow.starts_on || '',
    endsOn: remoteRow.ends_on || '',
    startTime: remoteRow.start_time,
    endTime: remoteRow.end_time,
    notes: remoteRow.notes || '',
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localC) return remote;
  if (newer(remote.updatedAt, localC.updatedAt)) return remote;
  return localC;
}

/**
 * Apply a full remote pull to the reducer state. Returns a new state object.
 *
 * @param {object} state Current reducer state.
 * @param {{subjects:Array, grades:Array, sessions:Array, assignments:Array, exams:Array, actions:Array}} remote
 */
function mergeNote(localNote, remoteRow) {
  const remote = {
    id: remoteRow.id,
    courseId: remoteRow.course_id ?? null,
    title: remoteRow.title ?? null,
    lessonDate: remoteRow.lesson_date ?? null,
    // The whole note under LWW. Character-level merge was considered and
    // rejected: two devices editing one note is rare in a single-user study
    // app, and a three-way text merge that gets it wrong silently interleaves
    // two revision sessions into something neither person wrote. Whole-row LWW
    // at least loses a whole edit visibly.
    content: remoteRow.content ?? '',
    sessionId: remoteRow.session_id ?? null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localNote) return remote;
  if (newer(remote.updatedAt, localNote.updatedAt)) return remote;
  return localNote;
}

function mergeNoteAttachment(localAtt, remoteRow) {
  const remote = {
    id: remoteRow.id,
    entryId: remoteRow.entry_id,
    storagePath: remoteRow.storage_path,
    fileName: remoteRow.file_name,
    mimeType: remoteRow.mime_type ?? null,
    sizeBytes: remoteRow.size_bytes ?? null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localAtt) return remote;
  if (newer(remote.updatedAt, localAtt.updatedAt)) return remote;
  return localAtt;
}

export function applyRemotePull(state, remote) {
  // Subjects → state.courses (keyed by id).
  const courses = { ...(state.courses || {}) };
  for (const row of remote.subjects) {
    courses[row.id] = mergeSubject(courses[row.id], row);
  }

  // Grades → state.grades (array).
  const gradeById = new Map((state.grades || []).map((g) => [g.id, g]));
  for (const row of remote.grades) {
    gradeById.set(row.id, mergeGrade(gradeById.get(row.id), row));
  }
  const grades = Array.from(gradeById.values());

  // Sessions → state.studySessions (array).
  const sessionById = new Map((state.studySessions || []).map((s) => [s.id, s]));
  for (const row of remote.sessions) {
    sessionById.set(row.id, mergeSession(sessionById.get(row.id), row));
  }
  const studySessions = Array.from(sessionById.values());

  // v1.7 — assignments / exams / actions. `remote.*` are defaulted rather than
  // assumed: a client that pulled before these tables existed (or a partial
  // response) must leave local data untouched instead of blanking it.
  //
  // Deletes are applied by REMOVAL here, not by keeping a tombstone in local
  // state — unlike courses/grades/sessions above.
  //
  // Why the difference: assignments, exams and actions are read in ~20 places
  // across App.jsx, none of which filter `deletedAt` today, because a local
  // delete has always spliced the row straight out of the array. Introducing
  // tombstones would mean adding a guard to every one of those call sites, and
  // a single miss puts a deleted assignment back on a user's screen. Dropping
  // the row instead keeps local state exactly the shape every existing render
  // path already expects, so this feature adds no new way for the working
  // views to break.
  //
  // Trade-off, accepted deliberately: a delete on one device beats a
  // simultaneous edit on another rather than going to LWW. For homework that
  // is the intuitive outcome — the thing is gone — and it is the same rule the
  // local delete already applies.
  const mergeList = (localList, remoteRows, mergeFn) => {
    const byId = new Map((localList || []).map((x) => [x.id, x]));
    for (const row of remoteRows || []) {
      if (row.deleted_at) { byId.delete(row.id); continue; }
      byId.set(row.id, mergeFn(byId.get(row.id), row));
    }
    return Array.from(byId.values());
  };

  const assignments = mergeList(state.assignments, remote.assignments, mergeAssignment);
  const exams = mergeList(state.exams, remote.exams, mergeExam);
  // Only manual to-dos live in state.actions; the Actions view derives its
  // suggestions from assignments/exams at render time and never persists them,
  // so there is nothing extra to filter out here.
  const actions = mergeList(state.actions, remote.actions, mergeAction);

  // v1.10. `remote.*` defaulted for the same reason as above: a client that
  // pulled before these tables existed, or a partial response where one of the
  // ten selects failed, must leave the local list untouched rather than blank
  // a term tree the user just built.
  const plannedSessions = mergeList(state.plannedSessions, remote.plannedSessions, mergePlannedSession);
  const academicTerms = mergeList(state.academicTerms, remote.academicTerms, mergeTerm);
  const timetableEntries = mergeList(state.timetableEntries, remote.timetableEntries, mergeTimetableEntry);
  const attachments = mergeList(state.attachments, remote.attachments, mergeAttachment);
  const commitments = mergeList(state.commitments, remote.commitments, mergeCommitment);
  // v1.13 Item 1b. Tombstone-removal like the assignments above rather than a
  // kept `deletedAt`, for the same reason: the notebook tree and the editor
  // both read the list without filtering, and one missed guard would put a
  // deleted note back on somebody's screen.
  const notes = mergeList(state.notes, remote.notes, mergeNote);
  const noteAttachments = mergeList(state.noteAttachments, remote.noteAttachments, mergeNoteAttachment);

  return {
    ...state,
    courses, grades, studySessions, assignments, exams, actions, notes, noteAttachments,
    plannedSessions, academicTerms, timetableEntries, attachments, commitments,
  };
}
