// Sync layer for StudyDesk ↔ Nexus shared Supabase project.
//
// Pattern (v1, per brief):
//   - UI handlers dispatch the local reducer action first (instant feedback)
//     then await the push function below. Failures surface as a toast.
//   - Realtime postgres_changes events trigger schedulePull(), which
//     coalesces bursts within 1.5s and does a full pull + LWW merge.
//
// All times stored as ISO strings. Soft-delete via deleted_at (never hard DELETE).

import { supabase } from './supabase.js';

// ── helpers ──────────────────────────────────────────────────────────────────

async function currentUserId() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  return user.id;
}

function nowISO() { return new Date().toISOString(); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// ── subjects (courses) ───────────────────────────────────────────────────────

export async function upsertSubject({ id, name, credits, semester, color, archivedAt, schoolYear }) {
  const userId = await currentUserId();
  const { error } = await supabase.from('subjects').upsert({
    id,
    user_id: userId,
    name,
    credits: credits ?? 1,
    semester: semester ?? null,
    // v1.0.3 — color is shared with Nexus-Command-Center. Pass through whatever
    // the local course has (StudyDesk's color picker writes COURSE_COLORS values);
    // null is acceptable if unset. LWW resolution on updated_at.
    color: color ?? null,
    // v1.2 — archived_at carries semester archive state. Null means active.
    // The "archive semester" UI batches by semester but each row pushes
    // individually here. archivedAt === undefined preserves prior value
    // (don't pass through to the upsert), null/ISO string sets it.
    ...(archivedAt !== undefined ? { archived_at: archivedAt } : {}),
    // v1.5 — school_year groups periods/jaksot for the history view. Same
    // preserve-on-undefined semantics as archived_at: callers that don't know
    // about it (e.g. NCC, the add-course path) won't clobber an existing value.
    ...(schoolYear !== undefined ? { school_year: schoolYear } : {}),
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

/**
 * Batch-archive every subject (course) tagged with the given semester.
 *
 * Walks the local courses list to know which IDs to touch — Supabase
 * doesn't have a "WHERE semester = X AND user_id = me" upsert path that
 * preserves other columns, so we hit each row individually. Fire all
 * upserts in parallel; per-row failures don't poison the batch.
 *
 * Returns { archived, failed } counts so the UI can flash an accurate
 * confirmation. Caller is responsible for dispatching the corresponding
 * local reducer action first (instant feedback).
 */
export async function archiveSemester(courses, semester) {
  const stamp = nowISO();
  const targets = Object.values(courses || {}).filter(
    (c) => !c.deletedAt && !c.archivedAt && c.semester === semester,
  );
  const results = await Promise.allSettled(
    targets.map((c) =>
      upsertSubject({
        id: c.id,
        name: c.name,
        credits: c.credits,
        semester: c.semester,
        schoolYear: c.schoolYear,
        color: c.color,
        archivedAt: stamp,
      }),
    ),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { archived: targets.length - failed, failed };
}

/**
 * Restore every archived subject tagged with the given semester. Inverse
 * of archiveSemester. Same per-row semantics.
 */
export async function restoreSemester(courses, semester) {
  const targets = Object.values(courses || {}).filter(
    (c) => !c.deletedAt && c.archivedAt && c.semester === semester,
  );
  const results = await Promise.allSettled(
    targets.map((c) =>
      upsertSubject({
        id: c.id,
        name: c.name,
        credits: c.credits,
        semester: c.semester,
        schoolYear: c.schoolYear,
        color: c.color,
        archivedAt: null,
      }),
    ),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { restored: targets.length - failed, failed };
}

export async function deleteSubject(id) {
  // Soft-delete the subject AND cascade-soft-delete its grades, per brief.
  const stamp = nowISO();
  const { error: gErr } = await supabase
    .from('grades')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('subject_id', id);
  if (gErr) throw gErr;
  // v1.7 — assignments and exams cascade too, matching the local reducer, which
  // drops both when a course is deleted. study_actions deliberately do NOT:
  // locally they survive with a dangling courseId, and silently destroying a
  // user's to-do list because it happened to be tagged to a deleted course
  // would be a worse surprise than an orphaned tag.
  const [aErr, eErr] = await Promise.all([
    supabase.from('assignments').update({ deleted_at: stamp, updated_at: stamp }).eq('subject_id', id),
    supabase.from('exams').update({ deleted_at: stamp, updated_at: stamp }).eq('subject_id', id),
  ]).then((rs) => rs.map((r) => r.error));
  if (aErr) throw aErr;
  if (eErr) throw eErr;
  const { error } = await supabase
    .from('subjects')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

// ── grades ───────────────────────────────────────────────────────────────────

export async function upsertGrade({ id, subjectId, grade, weight, date }) {
  if (!subjectId) throw new Error('subjectId is required (grade must reference a subject)');
  const userId = await currentUserId();
  const { error } = await supabase.from('grades').upsert({
    id,
    user_id: userId,
    subject_id: subjectId,
    grade,
    weight: weight ?? 1,
    date: date ?? todayISO(),
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function deleteGrade(id) {
  const stamp = nowISO();
  const { error } = await supabase
    .from('grades')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

// ── study sessions ───────────────────────────────────────────────────────────

// v1.3 (BUG-22) — focus_rating is an optional 1–5 quality score. null = skipped.
// Clamp defensively so a corrupt local value can't violate the DB CHECK constraint.
function clampFocus(focusRating) {
  if (focusRating == null) return null;
  const n = Math.round(Number(focusRating));
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, n));
}

export async function logStudySession({ id, subjectId, startedAt, durationMinutes, notes, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary }) {
  const userId = await currentUserId();
  const duration = Math.max(1, Math.min(1440, Math.round(durationMinutes)));
  // Idempotent UPSERT (was INSERT) so the v1.0.4 post-migration push can
  // safely retry every row without duplicate-key conflicts. Normal session
  // creation still works the same — id is generated client-side via
  // crypto.randomUUID() so collisions are vanishingly unlikely.
  const { error } = await supabase.from('study_sessions').upsert({
    id,
    user_id: userId,
    subject_id: subjectId || null,
    started_at: startedAt,
    duration_minutes: duration,
    notes: notes || null,
    focus_rating: clampFocus(focusRating),
    // v1.4 — optional AI debrief fields (all null when the user skipped it).
    ai_debrief_raw: aiDebriefRaw ?? null,
    ai_subject_covered: aiSubjectCovered ?? null,
    ai_comprehension: aiComprehension ?? null,
    ai_confusion_flags: Array.isArray(aiConfusionFlags) ? aiConfusionFlags : null,
    ai_session_summary: aiSessionSummary ?? null,
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function updateStudySession({ id, subjectId, startedAt, durationMinutes, notes, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary }) {
  const patch = { updated_at: nowISO() };
  if (subjectId !== undefined) patch.subject_id = subjectId || null;
  if (startedAt !== undefined) patch.started_at = startedAt;
  if (durationMinutes !== undefined) {
    patch.duration_minutes = Math.max(1, Math.min(1440, Math.round(durationMinutes)));
  }
  if (notes !== undefined) patch.notes = notes || null;
  if (focusRating !== undefined) patch.focus_rating = clampFocus(focusRating);
  if (aiDebriefRaw !== undefined) patch.ai_debrief_raw = aiDebriefRaw ?? null;
  if (aiSubjectCovered !== undefined) patch.ai_subject_covered = aiSubjectCovered ?? null;
  if (aiComprehension !== undefined) patch.ai_comprehension = aiComprehension ?? null;
  if (aiConfusionFlags !== undefined) patch.ai_confusion_flags = Array.isArray(aiConfusionFlags) ? aiConfusionFlags : null;
  if (aiSessionSummary !== undefined) patch.ai_session_summary = aiSessionSummary ?? null;
  const { error } = await supabase.from('study_sessions').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteStudySession(id) {
  const stamp = nowISO();
  const { error } = await supabase
    .from('study_sessions')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

// ── assignments · exams · actions ────────────────────────────────────────────
//
// v1.7 (StudyDesk#6). These three were local-only until now: a user with a
// phone and a tablet saw courses and grades sync while homework silently
// stayed put. They follow the same contract as everything above — client-set
// updated_at for LWW, soft delete via deleted_at, never a hard DELETE.

export async function upsertAssignment({ id, courseId, title, type, dueDate, notes, done }) {
  if (!courseId) throw new Error('courseId is required (assignment must reference a course)');
  const userId = await currentUserId();
  const { error } = await supabase.from('assignments').upsert({
    id,
    user_id: userId,
    subject_id: courseId,
    title,
    type: type ?? null,
    // The local model stores an empty string when the user clears the date;
    // `date` columns reject '' but accept null.
    due_date: dueDate || null,
    notes: notes || null,
    done: Boolean(done),
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function deleteAssignment(id) {
  const stamp = nowISO();
  const { error } = await supabase
    .from('assignments')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

export async function upsertExam({ id, courseId, title, dueDate, difficulty, notes, done, topics }) {
  if (!courseId) throw new Error('courseId is required (exam must reference a course)');
  const userId = await currentUserId();
  const { error } = await supabase.from('exams').upsert({
    id,
    user_id: userId,
    subject_id: courseId,
    title,
    due_date: dueDate || null,
    difficulty: difficulty ?? null,
    notes: notes || null,
    done: Boolean(done),
    // Topics ride along inside the exam row. Guard the shape: a corrupt local
    // value would otherwise fail the jsonb column and block the whole push.
    topics: Array.isArray(topics) ? topics : [],
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function deleteExam(id) {
  const stamp = nowISO();
  const { error } = await supabase
    .from('exams')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

export async function upsertAction({ id, text, bucket, courseId, done }) {
  const userId = await currentUserId();
  const { error } = await supabase.from('study_actions').upsert({
    id,
    user_id: userId,
    // Unlike assignments/exams, a to-do need not belong to a course.
    subject_id: courseId || null,
    text,
    bucket: bucket || 'today',
    done: Boolean(done),
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function deleteAction(id) {
  const stamp = nowISO();
  const { error } = await supabase
    .from('study_actions')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

// ── planned sessions ─────────────────────────────────────────────────────────
//
// v1.10. A SEPARATE TABLE FROM `study_sessions`, and it must stay that way.
// NCC derives its study signals and Life Score from `study_sessions`; a
// `planned` boolean on that table would count blocks the user merely *intended*
// as study they actually did, and every NCC version already in the wild on
// F-Droid would keep doing so forever — old versions cannot be taught to
// filter a column that did not exist when they shipped (`P1`).

export async function upsertPlannedSession({ id, subjectId, startsAt, durationMinutes, title, notes, fulfilledBy, dismissedAt }) {
  const userId = await currentUserId();
  const row = {
    id,
    user_id: userId,
    subject_id: subjectId || null,
    starts_at: startsAt,
    duration_minutes: Math.max(1, Math.min(1440, Math.round(durationMinutes))),
    title: title || null,
    notes: notes || null,
    updated_at: nowISO(),
  };
  // The DB forbids a row being both fulfilled and dismissed. Sending only the
  // key that is set would leave a stale opposite value in place and trip that
  // constraint on the next write, so both are always written — the caller's
  // pair is the whole truth about this block's outcome.
  row.fulfilled_by = fulfilledBy || null;
  row.dismissed_at = dismissedAt || null;
  if (row.fulfilled_by && row.dismissed_at) row.dismissed_at = null;
  const { error } = await supabase.from('planned_sessions').upsert(row);
  if (error) throw error;
  return id;
}

export async function deletePlannedSession(id) {
  const stamp = nowISO();
  const { error } = await supabase
    .from('planned_sessions')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

// ── academic terms · timetable ───────────────────────────────────────────────

export async function upsertTerm({ id, parentId, level, name, startsOn, endsOn, position }) {
  const userId = await currentUserId();
  const { error } = await supabase.from('academic_terms').upsert({
    id,
    user_id: userId,
    // A 'year' must have no parent and anything else must have one — the DB
    // enforces both, so a UI bug surfaces as a failed push rather than as a
    // term tree that renders in an impossible shape.
    parent_id: level === 'year' ? null : (parentId || null),
    level,
    name,
    // Empty string is what the date inputs produce when cleared; `date`
    // columns reject it and accept null.
    starts_on: startsOn || null,
    ends_on: endsOn || null,
    position: Number.isFinite(Number(position)) ? Number(position) : 0,
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

/**
 * Soft-delete a term, its descendant terms, and every timetable entry hanging
 * off any of them.
 *
 * The table's foreign keys cascade on a HARD delete, which is not what happens
 * here — nothing in this app ever issues a DELETE. Without walking the tree,
 * removing a school year would leave its semesters and their lessons live on
 * every other device, orphaned from a parent that no longer resolves, and
 * `resolveTermRange` would then fall back past the missing ancestor and start
 * drawing those lessons across the wrong dates.
 */
export async function deleteTerm({ id, descendantIds = [] }) {
  const stamp = nowISO();
  const ids = [id, ...descendantIds];
  const { error: teErr } = await supabase
    .from('timetable_entries')
    .update({ deleted_at: stamp, updated_at: stamp })
    .in('term_id', ids);
  if (teErr) throw teErr;
  const { error } = await supabase
    .from('academic_terms')
    .update({ deleted_at: stamp, updated_at: stamp })
    .in('id', ids);
  if (error) throw error;
}

export async function upsertTimetableEntry({ id, termId, subjectId, title, weekday, startsAt, endsAt, room, color }) {
  if (!termId) throw new Error('termId is required (a lesson must belong to a term)');
  const userId = await currentUserId();
  const { error } = await supabase.from('timetable_entries').upsert({
    id,
    user_id: userId,
    term_id: termId,
    subject_id: subjectId || null,
    // The DB requires a subject or a non-blank title. Trimmed here so a title
    // of spaces fails locally in the form rather than as a constraint error
    // three retries deep in the outbox.
    title: (title || '').trim() || null,
    weekday: Math.max(0, Math.min(6, Math.round(Number(weekday)))),
    starts_at: startsAt,
    ends_at: endsAt,
    room: (room || '').trim() || null,
    color: color || null,
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function deleteTimetableEntry(id) {
  const stamp = nowISO();
  const { error } = await supabase
    .from('timetable_entries')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
}

// ── assignment attachments ───────────────────────────────────────────────────
//
// Storage paths are `<user_id>/<assignment_id>/<file>`. The first segment is
// LOAD-BEARING, not cosmetic: the storage policy reads path segment 1 and
// compares it to `auth.uid()`, and the table carries a CHECK that
// `storage_path` starts with the row's own `user_id`. Build the path any other
// way and the upload is refused.

export const ATTACHMENT_BUCKET = 'assignment-attachments';
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Strip anything that would change the meaning of a storage path, and keep
 *  the result short enough that a long name plus two UUID segments stays well
 *  inside the key length Storage accepts. The original name is preserved on
 *  the row and is what the user sees — this only sanitises the KEY. */
export function safeFileName(name) {
  const cleaned = String(name || 'file')
    .normalize('NFKD')
    // Path separators and `..` are the reason this function exists; the rest is
    // to keep keys predictable across the S3-backed store.
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-');
  const trimmed = cleaned.slice(0, 80);
  return trimmed || 'file';
}

/**
 * Upload one file and register it against an assignment.
 *
 * NOT routed through the outbox, deliberately. The outbox persists its queue as
 * JSON in localStorage, and a `File` does not survive `JSON.stringify` — it
 * would serialise to `{}` and the retry would upload an empty object under a
 * real filename. An upload therefore requires connectivity, and the caller
 * surfaces the failure rather than pretending it was queued.
 */
export async function uploadAttachment({ assignmentId, file }) {
  if (!assignmentId) throw new Error('assignmentId is required');
  if (!file) throw new Error('file is required');
  if (file.size > ATTACHMENT_MAX_BYTES) {
    const e = new Error('too-large');
    e.code = 'too-large';
    throw e;
  }
  const userId = await currentUserId();
  const id = crypto.randomUUID();
  const path = `${userId}/${assignmentId}/${id}-${safeFileName(file.name)}`;
  const { error: upErr } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      // Never overwrite: the id in the key makes every path unique, so an
      // upsert here could only ever mask a collision that should not happen.
      upsert: false,
    });
  if (upErr) throw upErr;

  const row = {
    id,
    user_id: userId,
    assignment_id: assignmentId,
    storage_path: path,
    file_name: String(file.name || 'file').slice(0, 200),
    mime_type: file.type || null,
    size_bytes: file.size ?? null,
    updated_at: nowISO(),
  };
  const { error } = await supabase.from('assignment_attachments').insert(row);
  if (error) {
    // The object is already in the bucket. Leaving it there would be a file
    // the user is billed for, can never see and can never delete, so the
    // upload is rolled back before the error is surfaced.
    try { await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]); } catch { /* best effort */ }
    throw error;
  }
  return {
    id,
    assignmentId,
    storagePath: path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at,
    deletedAt: null,
  };
}

/** Short-lived signed URL for viewing/downloading one attachment. The bucket
 *  is private, so there is no public URL to fall back on. */
export async function signedAttachmentUrl(storagePath, expiresIn = 60) {
  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error) throw error;
  return data?.signedUrl || null;
}

export async function deleteAttachment({ id, storagePath }) {
  const stamp = nowISO();
  // Row first. If the object removal fails, the user sees the attachment gone
  // (which is what they asked for) and the orphan is a storage-cleanup
  // problem; doing it the other way round can leave a row pointing at nothing,
  // which renders as a file that errors every time it is opened.
  const { error } = await supabase
    .from('assignment_attachments')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('id', id);
  if (error) throw error;
  if (storagePath) {
    const { error: rmErr } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);
    if (rmErr) throw rmErr;
  }
}

// ── pull (full sync) ─────────────────────────────────────────────────────────

export async function pullAllStudyData() {
  // Pull EVERYTHING including soft-deleted rows so the local LWW merge
  // can correctly tombstone things the user deleted on another device.
  const [
    subjectsRes, gradesRes, sessionsRes, assignmentsRes, examsRes, actionsRes,
    plannedRes, termsRes, timetableRes, attachmentsRes,
  ] = await Promise.all([
    supabase.from('subjects').select('*'),
    supabase.from('grades').select('*'),
    supabase.from('study_sessions').select('*'),
    supabase.from('assignments').select('*'),
    supabase.from('exams').select('*'),
    supabase.from('study_actions').select('*'),
    supabase.from('planned_sessions').select('*'),
    supabase.from('academic_terms').select('*'),
    supabase.from('timetable_entries').select('*'),
    supabase.from('assignment_attachments').select('*'),
  ]);
  if (subjectsRes.error) throw subjectsRes.error;
  if (gradesRes.error) throw gradesRes.error;
  if (sessionsRes.error) throw sessionsRes.error;
  if (assignmentsRes.error) throw assignmentsRes.error;
  if (examsRes.error) throw examsRes.error;
  if (actionsRes.error) throw actionsRes.error;
  if (plannedRes.error) throw plannedRes.error;
  if (termsRes.error) throw termsRes.error;
  if (timetableRes.error) throw timetableRes.error;
  if (attachmentsRes.error) throw attachmentsRes.error;
  return {
    subjects: subjectsRes.data || [],
    grades: gradesRes.data || [],
    sessions: sessionsRes.data || [],
    assignments: assignmentsRes.data || [],
    exams: examsRes.data || [],
    actions: actionsRes.data || [],
    plannedSessions: plannedRes.data || [],
    academicTerms: termsRes.data || [],
    timetableEntries: timetableRes.data || [],
    attachments: attachmentsRes.data || [],
  };
}

// ── realtime ────────────────────────────────────────────────────────────────

let channel = null;
let pullTimer = null;
const COALESCE_MS = 1500;

function schedulePull(pullAll) {
  if (pullTimer) return;
  pullTimer = setTimeout(() => {
    pullTimer = null;
    Promise.resolve(pullAll()).catch((e) => {
      console.error('[sync] pullAll failed:', e);
    });
  }, COALESCE_MS);
}

/**
 * Start Realtime subscription to subjects/grades/study_sessions.
 * On any event, debounce 1.5s then call onChange() (which should pull+merge).
 */
export function startRealtime(onChange) {
  if (channel) return;
  const c = supabase.channel('studydesk-sync');
  // v1.7 — assignments/exams/study_actions joined the set (StudyDesk#6). All
  // six coalesce into the same debounced pull, so adding three tables costs one
  // extra subscription each, not three extra round-trips.
  // v1.10 — planned sessions, terms, timetable and attachments join the same
  // debounced pull. Ten subscriptions, still one round-trip per burst.
  for (const table of [
    'subjects', 'grades', 'study_sessions', 'assignments', 'exams', 'study_actions',
    'planned_sessions', 'academic_terms', 'timetable_entries', 'assignment_attachments',
  ]) {
    c.on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      () => schedulePull(onChange),
    );
  }
  c.subscribe();
  channel = c;
}

export function stopRealtime() {
  if (channel) {
    try { supabase.removeChannel(channel); } catch { /* ignore */ }
    channel = null;
  }
  if (pullTimer) {
    clearTimeout(pullTimer);
    pullTimer = null;
  }
}
