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

export async function upsertSubject({ id, name, credits, semester, color }) {
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
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function deleteSubject(id) {
  // Soft-delete the subject AND cascade-soft-delete its grades, per brief.
  const stamp = nowISO();
  const { error: gErr } = await supabase
    .from('grades')
    .update({ deleted_at: stamp, updated_at: stamp })
    .eq('subject_id', id);
  if (gErr) throw gErr;
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

export async function logStudySession({ id, subjectId, startedAt, durationMinutes, notes }) {
  const userId = await currentUserId();
  const duration = Math.max(1, Math.min(1440, Math.round(durationMinutes)));
  const { error } = await supabase.from('study_sessions').insert({
    id,
    user_id: userId,
    subject_id: subjectId || null,
    started_at: startedAt,
    duration_minutes: duration,
    notes: notes || null,
    updated_at: nowISO(),
  });
  if (error) throw error;
  return id;
}

export async function updateStudySession({ id, subjectId, startedAt, durationMinutes, notes }) {
  const patch = { updated_at: nowISO() };
  if (subjectId !== undefined) patch.subject_id = subjectId || null;
  if (startedAt !== undefined) patch.started_at = startedAt;
  if (durationMinutes !== undefined) {
    patch.duration_minutes = Math.max(1, Math.min(1440, Math.round(durationMinutes)));
  }
  if (notes !== undefined) patch.notes = notes || null;
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

// ── pull (full sync) ─────────────────────────────────────────────────────────

export async function pullAllStudyData() {
  // Pull EVERYTHING including soft-deleted rows so the local LWW merge
  // can correctly tombstone things the user deleted on another device.
  const [subjectsRes, gradesRes, sessionsRes] = await Promise.all([
    supabase.from('subjects').select('*'),
    supabase.from('grades').select('*'),
    supabase.from('study_sessions').select('*'),
  ]);
  if (subjectsRes.error) throw subjectsRes.error;
  if (gradesRes.error) throw gradesRes.error;
  if (sessionsRes.error) throw sessionsRes.error;
  return {
    subjects: subjectsRes.data || [],
    grades: gradesRes.data || [],
    sessions: sessionsRes.data || [],
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
