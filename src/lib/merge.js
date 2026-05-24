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
  return remoteIso > localIso;
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
export function mergeSubject(localCourse, remoteRow) {
  const remote = {
    id: remoteRow.id,
    name: remoteRow.name,
    credits: remoteRow.credits ?? 1,
    semester: remoteRow.semester ?? null,
    color: remoteRow.color || null,
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

export function mergeGrade(localGrade, remoteRow) {
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

export function mergeSession(localSession, remoteRow) {
  const remote = {
    id: remoteRow.id,
    subjectId: remoteRow.subject_id || null,
    startedAt: remoteRow.started_at,
    durationMinutes: remoteRow.duration_minutes,
    notes: remoteRow.notes || null,
    updatedAt: remoteRow.updated_at || null,
    deletedAt: remoteRow.deleted_at || null,
  };
  if (!localSession) return remote;
  if (newer(remote.updatedAt, localSession.updatedAt)) return remote;
  return localSession;
}

/**
 * Apply a full remote pull to the reducer state. Returns a new state object.
 *
 * @param {object} state Current reducer state.
 * @param {{subjects:Array, grades:Array, sessions:Array}} remote
 */
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

  return { ...state, courses, grades, studySessions };
}
