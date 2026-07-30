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

// ── pull (full sync) ─────────────────────────────────────────────────────────

export async function pullAllStudyData() {
  // Pull EVERYTHING including soft-deleted rows so the local LWW merge
  // can correctly tombstone things the user deleted on another device.
  const [subjectsRes, gradesRes, sessionsRes, assignmentsRes, examsRes, actionsRes] = await Promise.all([
    supabase.from('subjects').select('*'),
    supabase.from('grades').select('*'),
    supabase.from('study_sessions').select('*'),
    supabase.from('assignments').select('*'),
    supabase.from('exams').select('*'),
    supabase.from('study_actions').select('*'),
  ]);
  if (subjectsRes.error) throw subjectsRes.error;
  if (gradesRes.error) throw gradesRes.error;
  if (sessionsRes.error) throw sessionsRes.error;
  if (assignmentsRes.error) throw assignmentsRes.error;
  if (examsRes.error) throw examsRes.error;
  if (actionsRes.error) throw actionsRes.error;
  return {
    subjects: subjectsRes.data || [],
    grades: gradesRes.data || [],
    sessions: sessionsRes.data || [],
    assignments: assignmentsRes.data || [],
    exams: examsRes.data || [],
    actions: actionsRes.data || [],
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
  for (const table of ['subjects', 'grades', 'study_sessions']) {
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
