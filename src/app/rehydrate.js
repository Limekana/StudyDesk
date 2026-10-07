// Rebuilds the app's state from localStorage on launch: useReducer's lazy initializer.
// Moved out of App.jsx unchanged and called from the same place (limecore#12).
import { isGradeMode, normalizeScale, DEFAULT_CUSTOM_SCALE } from "../lib/gradeScale.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rehydrateState(init) {
  try {
    const raw = localStorage.getItem("studydesk-v1");
    const saved = raw ? JSON.parse(raw) : {};
    // Normalize legacy course rows that pre-date credits/semester/timestamps.
    // v1.2 adds archivedAt — defaults to null (active) on rehydration.
    // Guard each field's shape independently so a single malformed field
    // (e.g. a non-array `assignments` from a partial write) falls back to
    // empty for THAT field only — never throwing out to the catch, which
    // would blank ALL local data and let the persist effect overwrite it.
    const savedCourses = saved.courses && typeof saved.courses === "object" ? saved.courses : {};
    const courses = {};
    for (const [id, c] of Object.entries(savedCourses)) {
      courses[id] = {
        notes: [],
        credits: 1,
        semester: null,
        schoolYear: null,
        updatedAt: null,
        deletedAt: null,
        archivedAt: null,
        ...c,
      };
    }
    const gradeMode = (() => {
      try {
        const raw = localStorage.getItem("studydesk-grade-mode");
        return isGradeMode(raw) ? raw : "ib";
      } catch { return "ib"; }
    })();
    const customScale = (() => {
      try {
        const raw = localStorage.getItem("studydesk-grade-scale");
        return raw ? normalizeScale(JSON.parse(raw)) : DEFAULT_CUSTOM_SCALE;
      } catch { return DEFAULT_CUSTOM_SCALE; }
    })();
    // Absent key reads as false, so every existing install starts opted out
    // rather than inheriting an "on" it was never asked about.
    const aiEnabled = (() => {
      try { return localStorage.getItem("studydesk-ai-enabled") === "1"; } catch { return false; }
    })();
    // Lock In's native extras. The chip's key is absent for everyone who
    // installed before v1.10, and absent must mean ON there — it is the
    // half of the feature the owner actually asked for. Pinning's absent
    // key means OFF, because nobody consents to being locked in by default.
    const focusChip = (() => {
      try { return localStorage.getItem("studydesk-focus-chip") !== "0"; } catch { return true; }
    })();
    const focusPin = (() => {
      try { return localStorage.getItem("studydesk-focus-pin") === "1"; } catch { return false; }
    })();
    // Study-until. Absent means the default is in force, which is the right
    // reading for every install that predates the setting — the evening was
    // never deliberately excluded, it just fell off the end of the window.
    // An explicit "off" is the only thing that disables it.
    const studyUntil = (() => {
      try {
        const raw = localStorage.getItem("studydesk-study-until");
        if (raw === null) return 21*60;
        if (raw === "off") return null;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.max(0, Math.min(24*60, Math.round(n))) : 21*60;
      } catch { return 21*60; }
    })();
    // Planned-session reminders. Absent keys mean the defaults, which is the
    // right reading for an install that predates the feature — nobody there
    // declined it, it did not exist.
    const planRemindLead = (() => {
      try {
        const raw = localStorage.getItem("studydesk-plan-lead");
        if (raw === null) return 30;
        if (raw === "off") return null;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.max(1, Math.min(24*60, Math.round(n))) : 30;
      } catch { return 30; }
    })();
    const planRemindStart = (() => {
      try { return localStorage.getItem("studydesk-plan-start") !== "0"; } catch { return true; }
    })();
    // Reminders. The key is absent for everyone who onboarded before this
    // preference existed, and those users have already been through the
    // permission prompt — so absent-but-onboarded means keep scheduling, and
    // only an explicit "Maybe later" writes a "0". A blanket default of false
    // would silently stop reminders for every existing install.
    const notifEnabled = (() => {
      try {
        const raw = localStorage.getItem("studydesk-notifications");
        if (raw !== null) return raw === "1";
        return localStorage.getItem("studydesk-onboarded") === "1";
      } catch { return true; }
    })();

    // ── v1.0.4 UUID migration ────────────────────────────────────────────────
    // Earlier versions used short uid() strings for IDs. Supabase columns are
    // `uuid` type and reject them ("invalid input syntax for type uuid: ...").
    // This pass detects non-UUID local IDs and rewrites them — keeping all
    // cross-references intact (grade.subjectId, session.subjectId,
    // assignment.courseId, exam.courseId, action.courseId, activeCourse).
    // Marks `studydesk-needs-initial-push` so the App runs a one-shot push
    // of the migrated rows after auth lands.
    let needsPush = localStorage.getItem("studydesk-needs-initial-push") === "1";
    const subjectIdMap = {};
    const migratedCourses = {};
    for (const [oldId, c] of Object.entries(courses)) {
      if (UUID_RE.test(oldId)) {
        migratedCourses[oldId] = c;
        subjectIdMap[oldId] = oldId;
      } else {
        const newId = crypto.randomUUID();
        subjectIdMap[oldId] = newId;
        migratedCourses[newId] = { ...c, id: newId };
        needsPush = true;
      }
    }
    const migratedGrades = (Array.isArray(saved.grades) ? saved.grades : []).map(g => {
      const idOk = UUID_RE.test(g.id);
      const subjIdMapped = subjectIdMap[g.subjectId];
      const subjOk = !subjIdMapped || subjIdMapped === g.subjectId;
      if (idOk && subjOk) return g;
      needsPush = true;
      return {
        ...g,
        id: idOk ? g.id : crypto.randomUUID(),
        subjectId: subjIdMapped || g.subjectId,
      };
    });
    const migratedSessions = (Array.isArray(saved.studySessions) ? saved.studySessions : []).map(s => {
      const idOk = UUID_RE.test(s.id);
      const subjIdMapped = s.subjectId ? subjectIdMap[s.subjectId] : null;
      const subjOk = !s.subjectId || subjIdMapped === s.subjectId;
      if (idOk && subjOk) return s;
      needsPush = true;
      return {
        ...s,
        id: idOk ? s.id : crypto.randomUUID(),
        subjectId: s.subjectId ? (subjIdMapped || s.subjectId) : null,
      };
    });
    // ── v1.7 assignment/exam/action UUID migration (StudyDesk#6) ────────────
    // These were local-only until v1.7 and used short uid() ids, which the
    // new `uuid` columns reject outright. Re-key them here, exactly as the
    // v1.0.4 pass above did for courses/grades/sessions, and mark the batch
    // for the one-shot push so a user's existing homework reaches the cloud
    // rather than only newly created items.
    //
    // asgnIdMap/examIdMap are kept because manual actions can carry a
    // sourceId pointing at an assignment or exam. Re-keying the target
    // without remapping the reference would silently break "mark done" on
    // the suggested-action row.
    const asgnIdMap = {};
    const examIdMap = {};
    const migratedAssignments = (Array.isArray(saved.assignments) ? saved.assignments : []).map(a => {
      const idOk = UUID_RE.test(a.id);
      const mappedCourse = subjectIdMap[a.courseId];
      const courseOk = !mappedCourse || mappedCourse === a.courseId;
      if (!idOk) asgnIdMap[a.id] = crypto.randomUUID();
      if (idOk && courseOk) return a;
      needsPush = true;
      return {
        ...a,
        id: idOk ? a.id : asgnIdMap[a.id],
        courseId: mappedCourse || a.courseId,
      };
    });
    const migratedExams = (Array.isArray(saved.exams) ? saved.exams : []).map(e => {
      const idOk = UUID_RE.test(e.id);
      const mappedCourse = subjectIdMap[e.courseId];
      const courseOk = !mappedCourse || mappedCourse === e.courseId;
      if (!idOk) examIdMap[e.id] = crypto.randomUUID();
      if (idOk && courseOk) return e;
      needsPush = true;
      return {
        ...e,
        id: idOk ? e.id : examIdMap[e.id],
        courseId: mappedCourse || e.courseId,
      };
    });
    const migratedActions = (Array.isArray(saved.actions) ? saved.actions : []).map(a => {
      const idOk = UUID_RE.test(a.id);
      const mappedCourse = a.courseId ? subjectIdMap[a.courseId] : null;
      const courseOk = !a.courseId || mappedCourse === a.courseId;
      const mappedSource = a.sourceId ? (asgnIdMap[a.sourceId] || examIdMap[a.sourceId]) : null;
      if (idOk && courseOk && !mappedSource) return a;
      needsPush = true;
      return {
        ...a,
        id: idOk ? a.id : crypto.randomUUID(),
        courseId: a.courseId ? (mappedCourse || a.courseId) : null,
        sourceId: mappedSource || a.sourceId || null,
      };
    });
    const migratedActiveCourse = saved.activeCourse && subjectIdMap[saved.activeCourse]
      ? subjectIdMap[saved.activeCourse]
      : saved.activeCourse || null;

    if (needsPush) {
      try { localStorage.setItem("studydesk-needs-initial-push", "1"); } catch {}
    }

    return {
      ...init,
      ...saved,
      courses: migratedCourses,
      assignments: migratedAssignments,
      exams: migratedExams,
      actions: migratedActions,
      grades: migratedGrades,
      studySessions: migratedSessions,
      // v1.10. No UUID migration pass for these four: they were born after
      // v1.0.4, so every id they have ever held came from crypto.randomUUID.
      // Shape-guarded individually for the same reason as the lists above —
      // one malformed array must not blank the others.
      plannedSessions: Array.isArray(saved.plannedSessions) ? saved.plannedSessions : [],
      academicTerms: Array.isArray(saved.academicTerms) ? saved.academicTerms : [],
      timetableEntries: Array.isArray(saved.timetableEntries) ? saved.timetableEntries : [],
      attachments: Array.isArray(saved.attachments) ? saved.attachments : [],
      commitments: Array.isArray(saved.commitments) ? saved.commitments : [],
      notes: Array.isArray(saved.notes) ? saved.notes : [],
      noteAttachments: Array.isArray(saved.noteAttachments) ? saved.noteAttachments : [],
      attendance: Array.isArray(saved.attendance) ? saved.attendance : [],
      activeCourse: migratedActiveCourse,
      gradeMode,
      customScale,
      aiEnabled,
      notifEnabled,
      focusChip,
      focusPin,
      studyUntil,
      planRemindLead,
      planRemindStart,
      view: "actions",
    };
  } catch { return init; }
}
