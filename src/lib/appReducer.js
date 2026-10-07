// The app's state shape and reducer.
import { isGradeMode, normalizeScale, DEFAULT_CUSTOM_SCALE } from "./gradeScale.js";
import { applyRemotePull } from "./merge.js";
import { normalizeDueTime } from "./dueAt.js";

function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
// IDs that flow into Supabase MUST be proper UUIDs — the columns are typed `uuid`.
// `uid()` above produces short nanoid-style strings (~12 chars) which Postgres rejects.
// Keep `uid()` for local-only entities (assignments, exams, exam topics, actions);
// use `newSyncId()` for everything that crosses the sync boundary (subjects, grades,
// study sessions). Browser-native, no extra dep.
export function newSyncId() { return crypto.randomUUID(); }

export const INITIAL = {
  courses:{}, assignments:[], actions:[], exams:[],
  grades:[], studySessions:[],
  // v1.10 — planned study blocks, the School Year > Semester > Jakso tree, the
  // weekly lessons hanging off it, and assignment file attachments.
  // `plannedSessions` is separate from `studySessions` on purpose and must
  // stay that way: NCC reads study_sessions for its Life Score, so an intended
  // block living there would be counted as study that actually happened.
  plannedSessions:[], academicTerms:[], timetableEntries:[], attachments:[],
  // Non-study blockers — training, clubs, shifts. Time that is NOT available
  // for study, and never counted as study anywhere.
  commitments:[],
  // v1.13 Item 1b — the notebook. `notes` is the entries; `noteAttachments`
  // mirrors `attachments`. Named `notes` at the top level and NOT reused for
  // the per-course `notes` array on a course row, which is an older,
  // unrelated local-only field (see mergeSubject) — they never meet, because
  // one lives on `state.notes` and the other on `state.courses[id].notes`.
  notes:[], noteAttachments:[],
  // v1.13 Tier 2 (#31) — one row per lesson per date. The percentage is never
  // stored; see src/lib/attendance.js.
  attendance:[],
  gradeMode:"ib",                  // 'ib' | 'us' | 'custom' — persisted locally
  customScale:DEFAULT_CUSTOM_SCALE, // bounds for gradeMode 'custom' (SD-F4)
  aiEnabled:false,                 // AI debrief opt-in — device-level, persisted locally
  // v1.10 (Item 12) — Lock In's two native additions, independent on purpose.
  // The chip is harmless so it defaults on; screen pinning traps the user in
  // the app until they hold Back+Recents, so it defaults off and stays that way
  // until someone deliberately asks for it.
  focusChip:true, focusPin:false,
  // v1.10 (owner feedback) — how late you are willing to study, in minutes past
  // midnight, or null for "stop at whatever is already in the day".
  //
  // The calendar's free-window list used to end at the last lesson, which put
  // the evening — the part a student actually plans in — off the end of the
  // list entirely. 21:00 by default: late enough to be useful, early enough to
  // still read as "before bed" rather than "all night".
  studyUntil:21*60,
  // Reminders for planned study sessions. Two independent settings because
  // they answer different questions: the lead one is "start wrapping up", the
  // at-start one is "go". Both default on at the owner's suggested baseline.
  planRemindLead:30, planRemindStart:true,
  notifEnabled:true,               // reminders opt-in — set at onboarding, changeable in Settings
  view:"actions", activeCourse:null,
};

export function reducer(state, action) {
  switch(action.type) {
    // v1.14 Item 8a - `archivedAt` is settable at creation. A course can be
    // born archived: that is how a finished term's grades get entered without
    // the course first appearing in the live GPA, the Plan tab and every
    // course picker. Defaults to null, so every existing caller is unchanged.
    case "ADD_COURSE":    { const id=action.id||newSyncId(); return {...state,courses:{...state.courses,[id]:{id,name:action.name,color:action.color,notes:[],credits:action.credits??1,semester:action.semester??null,schoolYear:action.schoolYear??null,archivedAt:action.archivedAt??null,updatedAt:action.updatedAt||new Date().toISOString(),deletedAt:null}}}; }
    case "EDIT_COURSE":  return {...state,courses:{...state.courses,[action.id]:{...state.courses[action.id],name:action.name,color:action.color,credits:action.credits!==undefined?action.credits:state.courses[action.id]?.credits,semester:action.semester!==undefined?action.semester:state.courses[action.id]?.semester,schoolYear:action.schoolYear!==undefined?action.schoolYear:state.courses[action.id]?.schoolYear,updatedAt:new Date().toISOString()}}};
    // v1.2 — semester archiving. ARCHIVE_SEMESTER stamps archivedAt on
    // every active course matching the semester string; RESTORE_SEMESTER
    // clears it. Per-course variants for the case where the user wants
    // to hide just one course without archiving its whole semester
    // (e.g. dropped a class mid-term). Updating archivedAt bumps
    // updatedAt so LWW wins against any concurrent stale write.
    case "ARCHIVE_SEMESTER": {
      const stamp = action.stamp || new Date().toISOString();
      const next = { ...state.courses };
      for (const c of Object.values(state.courses || {})) {
        if (!c.deletedAt && !c.archivedAt && c.semester === action.semester) {
          next[c.id] = { ...c, archivedAt: stamp, updatedAt: stamp };
        }
      }
      return { ...state, courses: next };
    }
    case "RESTORE_SEMESTER": {
      const stamp = action.stamp || new Date().toISOString();
      const next = { ...state.courses };
      for (const c of Object.values(state.courses || {})) {
        if (!c.deletedAt && c.archivedAt && c.semester === action.semester) {
          next[c.id] = { ...c, archivedAt: null, updatedAt: stamp };
        }
      }
      return { ...state, courses: next };
    }
    case "ARCHIVE_COURSE": {
      const stamp = action.stamp || new Date().toISOString();
      const c = state.courses[action.id];
      if (!c) return state;
      return { ...state, courses: { ...state.courses, [action.id]: { ...c, archivedAt: stamp, updatedAt: stamp } } };
    }
    case "RESTORE_COURSE": {
      const stamp = action.stamp || new Date().toISOString();
      const c = state.courses[action.id];
      if (!c) return state;
      return { ...state, courses: { ...state.courses, [action.id]: { ...c, archivedAt: null, updatedAt: stamp } } };
    }
    case "DELETE_COURSE":{
      // Soft-delete the course in local state (mirrors what we push to Supabase).
      // Also tombstone any grades for the subject so the GPA recalculates,
      // and clear assignments/exams (those are local-only and harmless to drop).
      const stamp=new Date().toISOString();
      const c=state.courses[action.id];
      const courses={...state.courses};
      if(c) courses[action.id]={...c,deletedAt:stamp,updatedAt:stamp};
      return {
        ...state,
        courses,
        grades:state.grades.map(g=>g.subjectId===action.id?{...g,deletedAt:stamp,updatedAt:stamp}:g),
        assignments:state.assignments.filter(a=>a.courseId!==action.id),
        exams:state.exams.filter(e=>e.courseId!==action.id),
        activeCourse:state.activeCourse===action.id?null:state.activeCourse,
      };
    }
    // v1.7 (StudyDesk#6) — these three now sync, so they carry `updatedAt` for
    // LWW and use newSyncId() (a real UUID) instead of uid(). Deletes stay hard
    // removals: applyRemotePull drops remotely-deleted rows the same way, so
    // local state never holds a tombstone and no render site needs a new guard.
    case "ADD_ASSIGNMENT":  { const a={id:action.id||newSyncId(),courseId:action.courseId,title:action.title,type:action.assignType,dueDate:action.dueDate,dueTime:normalizeDueTime(action.dueTime),notes:action.notes||"",done:false,updatedAt:action.updatedAt||new Date().toISOString()}; return {...state,assignments:[...state.assignments,a]}; }
    case "TOGGLE_ASSIGNMENT": return {...state,assignments:state.assignments.map(a=>a.id===action.id?{...a,done:!a.done,updatedAt:new Date().toISOString()}:a)};
    case "EDIT_ASSIGNMENT":   return {...state,assignments:state.assignments.map(a=>a.id===action.id?{...a,title:action.title,dueDate:action.dueDate,dueTime:normalizeDueTime(action.dueTime),notes:action.notes,updatedAt:new Date().toISOString()}:a)};
    case "DELETE_ASSIGNMENT": return {...state,assignments:state.assignments.filter(a=>a.id!==action.id)};
    // v1.13 Tier 3 — upsert by id, for the calendar feed.
    //
    // ADD_ASSIGNMENT always appends, which is right for a user typing a new
    // one and wrong for a feed that re-fetches every six hours: the server
    // upsert converges on the derived id, but local state would grow a
    // duplicate on every poll until the next pull tidied it up.
    //
    // It also takes `assignType` rather than `type`, because the action's own
    // discriminator is called `type`. A caller spreading a row that carries a
    // `type` field into an action would silently overwrite the action name —
    // so this one takes an explicit `row` instead of being spread, which
    // makes that class of mistake impossible rather than merely documented.
    case "UPSERT_ASSIGNMENT": {
      const row = action.row || {};
      if (!row.id) return state;
      const now = new Date().toISOString();
      const i = state.assignments.findIndex(a => a.id === row.id);
      const next = {
        id: row.id,
        courseId: row.courseId ?? null,
        title: row.title || "",
        type: row.type || null,
        dueDate: row.dueDate || null,
        // The calendar feed carries a real start time when the source event
        // has one (VEVENT DTSTART), which is exactly a due time — so an
        // imported deadline is timed without the user retyping it.
        dueTime: normalizeDueTime(row.dueTime),
        notes: row.notes || "",
        // `done` is preserved on an existing row. A student who ticked off an
        // imported assignment must not have it un-ticked by the next poll —
        // the feed knows the deadline, not whether they did it.
        done: i >= 0 ? state.assignments[i].done : false,
        updatedAt: now,
      };
      if (i < 0) return {...state, assignments:[...state.assignments, next]};
      const copy = [...state.assignments];
      copy[i] = { ...copy[i], ...next };
      return {...state, assignments: copy};
    }
    case "ADD_EXAM":    { const e={id:action.id||newSyncId(),courseId:action.courseId,title:action.title,dueDate:action.dueDate,difficulty:action.difficulty||"medium",notes:action.notes||"",done:false,topics:[],updatedAt:action.updatedAt||new Date().toISOString()}; return {...state,exams:[...state.exams,e]}; }
    case "TOGGLE_EXAM": return {...state,exams:state.exams.map(e=>e.id===action.id?{...e,done:!e.done,updatedAt:new Date().toISOString()}:e)};
    // v1.13 (#45) — `deflate8818`, 2026-08-31: "Sometimes exams get
    // rescheduled, change name, aren't as difficult as once thought."
    // Assignments have had EDIT_ASSIGNMENT since v1.0; exams never did, so the
    // only route was delete-and-recreate — which loses the topic checklist,
    // the difficulty, and the study-start date derived from it. For an exam
    // three weeks out with half its topics ticked off, that is the worst
    // possible way to change a title.
    //
    // Difficulty is included here as well as in UPDATE_EXAM_DIFFICULTY: the
    // report names it ("aren't as difficult as once thought") and the pills
    // are only reachable with the card expanded, so the edit form has to
    // carry it too. Topics are deliberately NOT touched — they have their own
    // actions and a form field that could silently drop them is exactly the
    // loss this fixes.
    case "EDIT_EXAM": return {...state,exams:state.exams.map(e=>e.id!==action.id?e:{
      ...e,
      title: action.title !== undefined ? action.title : e.title,
      dueDate: action.dueDate !== undefined ? action.dueDate : e.dueDate,
      notes: action.notes !== undefined ? action.notes : e.notes,
      difficulty: action.difficulty !== undefined ? action.difficulty : e.difficulty,
      courseId: action.courseId !== undefined ? action.courseId : e.courseId,
      updatedAt: new Date().toISOString(),
    })};
    case "DELETE_EXAM": return {...state,exams:state.exams.filter(e=>e.id!==action.id)};
    case "UPDATE_EXAM_DIFFICULTY": return {...state,exams:state.exams.map(e=>e.id===action.id?{...e,difficulty:action.difficulty,updatedAt:new Date().toISOString()}:e)};
    // Topic ids stay uid(): they live inside the exam's jsonb payload and are
    // never rows of their own, so Postgres never sees them as a uuid column.
    case "ADD_EXAM_TOPIC":    return {...state,exams:state.exams.map(e=>e.id===action.examId?{...e,topics:[...(e.topics||[]),{id:uid(),title:action.title,done:false}],updatedAt:new Date().toISOString()}:e)};
    case "TOGGLE_EXAM_TOPIC": return {...state,exams:state.exams.map(e=>e.id===action.examId?{...e,topics:(e.topics||[]).map(t=>t.id===action.topicId?{...t,done:!t.done}:t),updatedAt:new Date().toISOString()}:e)};
    case "DELETE_EXAM_TOPIC": return {...state,exams:state.exams.map(e=>e.id===action.examId?{...e,topics:(e.topics||[]).filter(t=>t.id!==action.topicId),updatedAt:new Date().toISOString()}:e)};
    case "ADD_ACTION":    { const a={id:action.id||newSyncId(),text:action.text,bucket:action.bucket||"today",courseId:action.courseId||null,done:false,suggested:action.suggested||false,sourceId:action.sourceId||null,updatedAt:action.updatedAt||new Date().toISOString()}; return {...state,actions:[...state.actions,a]}; }
    case "TOGGLE_ACTION": return {...state,actions:state.actions.map(a=>a.id===action.id?{...a,done:!a.done,doneAt:!a.done?Date.now():null,updatedAt:new Date().toISOString()}:a)};
    case "DELETE_ACTION": return {...state,actions:state.actions.filter(a=>a.id!==action.id)};
    case "SET_VIEW":      return {...state,view:action.view,activeCourse:action.course!==undefined?action.course:state.activeCourse};

    // ── Grades (new schema: per-grade rows linked to a subject) ──
    case "ADD_GRADE":    { const g={id:action.id||newSyncId(),subjectId:action.subjectId,grade:Number(action.grade),weight:Number(action.weight??1),date:action.date||new Date().toISOString().slice(0,10),updatedAt:action.updatedAt||new Date().toISOString(),deletedAt:null}; return {...state,grades:[...(state.grades||[]),g]}; }
    case "EDIT_GRADE":   return {...state,grades:(state.grades||[]).map(g=>g.id===action.id?{...g,subjectId:action.subjectId??g.subjectId,grade:action.grade!==undefined?Number(action.grade):g.grade,weight:action.weight!==undefined?Number(action.weight):g.weight,date:action.date??g.date,updatedAt:new Date().toISOString()}:g)};
    case "DELETE_GRADE": { const stamp=new Date().toISOString(); return {...state,grades:(state.grades||[]).map(g=>g.id===action.id?{...g,deletedAt:stamp,updatedAt:stamp}:g)}; }

    // ── Study sessions ──
    case "ADD_SESSION":    { const s={id:action.id||newSyncId(),subjectId:action.subjectId||null,startedAt:action.startedAt,durationMinutes:Math.max(1,Math.min(1440,Math.round(action.durationMinutes))),notes:action.notes||null,focusRating:action.focusRating!=null?Math.max(1,Math.min(5,Math.round(action.focusRating))):null,aiDebriefRaw:action.aiDebriefRaw??null,aiSubjectCovered:action.aiSubjectCovered??null,aiComprehension:action.aiComprehension!=null?Math.max(1,Math.min(5,Math.round(action.aiComprehension))):null,aiConfusionFlags:Array.isArray(action.aiConfusionFlags)?action.aiConfusionFlags:null,aiSessionSummary:action.aiSessionSummary??null,updatedAt:action.updatedAt||new Date().toISOString(),deletedAt:null}; return {...state,studySessions:[...(state.studySessions||[]),s]}; }
    case "EDIT_SESSION":   return {...state,studySessions:(state.studySessions||[]).map(s=>s.id===action.id?{...s,subjectId:action.subjectId!==undefined?(action.subjectId||null):s.subjectId,startedAt:action.startedAt??s.startedAt,durationMinutes:action.durationMinutes!==undefined?Math.max(1,Math.min(1440,Math.round(action.durationMinutes))):s.durationMinutes,notes:action.notes!==undefined?(action.notes||null):s.notes,focusRating:action.focusRating!==undefined?(action.focusRating!=null?Math.max(1,Math.min(5,Math.round(action.focusRating))):null):s.focusRating,aiDebriefRaw:action.aiDebriefRaw!==undefined?action.aiDebriefRaw:s.aiDebriefRaw,aiSubjectCovered:action.aiSubjectCovered!==undefined?action.aiSubjectCovered:s.aiSubjectCovered,aiComprehension:action.aiComprehension!==undefined?(action.aiComprehension!=null?Math.max(1,Math.min(5,Math.round(action.aiComprehension))):null):s.aiComprehension,aiConfusionFlags:action.aiConfusionFlags!==undefined?(Array.isArray(action.aiConfusionFlags)?action.aiConfusionFlags:null):s.aiConfusionFlags,aiSessionSummary:action.aiSessionSummary!==undefined?action.aiSessionSummary:s.aiSessionSummary,updatedAt:new Date().toISOString()}:s)};
    case "DELETE_SESSION": { const stamp=new Date().toISOString(); return {...state,studySessions:(state.studySessions||[]).map(s=>s.id===action.id?{...s,deletedAt:stamp,updatedAt:stamp}:s)}; }

    // ── Planned study blocks (v1.10) ──
    // A block the user INTENDS to study. Never written to studySessions — see
    // the note on INITIAL. Deletes are hard removals locally, matching
    // assignments/exams: applyRemotePull drops remotely-deleted rows the same
    // way, so no render path needs a tombstone guard.
    case "ADD_PLANNED": {
      const p = {
        id: action.id || newSyncId(),
        subjectId: action.subjectId || null,
        startsAt: action.startsAt,
        durationMinutes: Math.max(1, Math.min(1440, Math.round(action.durationMinutes))),
        title: action.title || "",
        notes: action.notes || "",
        fulfilledBy: null,
        dismissedAt: null,
        // v1.14 Item 7a — which repeating plan this block came from, null for
        // a one-off. Every occurrence is an ordinary independent row; this is
        // a label so "stop repeating" can find the rest of them, not a parent.
        seriesId: action.seriesId || null,
        updatedAt: action.updatedAt || new Date().toISOString(),
      };
      return { ...state, plannedSessions: [...(state.plannedSessions || []), p] };
    }
    case "EDIT_PLANNED":
      return { ...state, plannedSessions: (state.plannedSessions || []).map(p => p.id !== action.id ? p : {
        ...p,
        subjectId: action.subjectId !== undefined ? (action.subjectId || null) : p.subjectId,
        startsAt: action.startsAt ?? p.startsAt,
        durationMinutes: action.durationMinutes !== undefined
          ? Math.max(1, Math.min(1440, Math.round(action.durationMinutes)))
          : p.durationMinutes,
        title: action.title !== undefined ? (action.title || "") : p.title,
        notes: action.notes !== undefined ? (action.notes || "") : p.notes,
        updatedAt: new Date().toISOString(),
      })};
    // The two outcomes are mutually exclusive, and the DB enforces that. Each
    // clears the other rather than only setting its own, so a block dismissed
    // and later fulfilled cannot end up claiming both.
    case "RESOLVE_PLANNED":
      return { ...state, plannedSessions: (state.plannedSessions || []).map(p => p.id !== action.id ? p : {
        ...p,
        fulfilledBy: action.fulfilledBy || null,
        dismissedAt: action.fulfilledBy ? null : (action.dismissedAt || null),
        updatedAt: new Date().toISOString(),
      })};
    // v1.14 Item 7a — dropping the remaining occurrences of a repeating plan.
    // Explicit ids, like DELETE_TT_ENTRIES: the caller counted them and showed
    // that count, so the reducer removes exactly what was confirmed.
    case "DELETE_PLANNED_MANY": {
      const ids = new Set(action.ids || []);
      if (!ids.size) return state;
      return { ...state, plannedSessions: (state.plannedSessions || []).filter(p => !ids.has(p.id)) };
    }
    case "DELETE_PLANNED":
      return { ...state, plannedSessions: (state.plannedSessions || []).filter(p => p.id !== action.id) };

    // ── Academic terms + timetable (v1.10) ──
    case "ADD_TERM": {
      const term = {
        id: action.id || newSyncId(),
        parentId: action.level === "year" ? null : (action.parentId || null),
        level: action.level,
        name: action.name,
        startsOn: action.startsOn || "",
        endsOn: action.endsOn || "",
        position: Number.isFinite(Number(action.position)) ? Number(action.position) : 0,
        updatedAt: action.updatedAt || new Date().toISOString(),
      };
      return { ...state, academicTerms: [...(state.academicTerms || []), term] };
    }
    case "EDIT_TERM":
      return { ...state, academicTerms: (state.academicTerms || []).map(x => x.id !== action.id ? x : {
        ...x,
        name: action.name ?? x.name,
        startsOn: action.startsOn !== undefined ? (action.startsOn || "") : x.startsOn,
        endsOn: action.endsOn !== undefined ? (action.endsOn || "") : x.endsOn,
        position: action.position !== undefined ? Number(action.position) || 0 : x.position,
        updatedAt: new Date().toISOString(),
      })};
    case "DELETE_TERM": {
      // Takes the whole subtree and every lesson attached to any of it.
      // Leaving descendants behind would orphan them from a parent that no
      // longer resolves, and resolveTermRange would then inherit dates from
      // further up the tree and draw those lessons across the wrong months.
      const doomed = new Set([action.id, ...(action.descendantIds || [])]);
      return {
        ...state,
        academicTerms: (state.academicTerms || []).filter(x => !doomed.has(x.id)),
        timetableEntries: (state.timetableEntries || []).filter(e => !doomed.has(e.termId)),
      };
    }
    case "ADD_TT_ENTRY": {
      const e = {
        id: action.id || newSyncId(),
        termId: action.termId,
        // v1.14 Item 6a — which multi-weekday set this belongs to, null for a
        // lesson that meets on one day.
        seriesId: action.seriesId || null,
        subjectId: action.subjectId || null,
        title: action.title || "",
        weekday: Math.max(0, Math.min(6, Math.round(Number(action.weekday)))),
        startsAt: action.startsAt,
        endsAt: action.endsAt,
        room: action.room || "",
        color: action.color || null,
        // v1.13 — null is "every week". Only 1 and 2 are meaningful; anything
        // else normalises to null here rather than being stored and having to
        // be defended against at every read.
        weekParity: action.weekParity === 1 || action.weekParity === 2 ? action.weekParity : null,
        updatedAt: action.updatedAt || new Date().toISOString(),
      };
      return { ...state, timetableEntries: [...(state.timetableEntries || []), e] };
    }
    case "EDIT_TT_ENTRY":
      return { ...state, timetableEntries: (state.timetableEntries || []).map(e => e.id !== action.id ? e : {
        ...e,
        // v1.14 Item 6b - the scope is editable now, which is what "move this
        // lesson to the jakso" is. Without this line the push carried the new
        // term and local state kept the old one, so the lesson stayed where it
        // was until the next pull contradicted the screen. Attendance is keyed
        // on the ENTRY, not the term, so a moved lesson keeps its history.
        termId: action.termId !== undefined ? (action.termId || e.termId) : e.termId,
        seriesId: action.seriesId !== undefined ? (action.seriesId || null) : (e.seriesId ?? null),
        subjectId: action.subjectId !== undefined ? (action.subjectId || null) : e.subjectId,
        title: action.title !== undefined ? (action.title || "") : e.title,
        weekday: action.weekday !== undefined ? Math.max(0, Math.min(6, Math.round(Number(action.weekday)))) : e.weekday,
        startsAt: action.startsAt ?? e.startsAt,
        endsAt: action.endsAt ?? e.endsAt,
        room: action.room !== undefined ? (action.room || "") : e.room,
        color: action.color !== undefined ? (action.color || null) : e.color,
        weekParity: action.weekParity !== undefined
          ? (action.weekParity === 1 || action.weekParity === 2 ? action.weekParity : null)
          : (e.weekParity ?? null),
        updatedAt: new Date().toISOString(),
      })};
    case "DELETE_TT_ENTRY":
      return { ...state, timetableEntries: (state.timetableEntries || []).filter(e => e.id !== action.id) };
    // v1.14 Item 6a — dropping every day of a multi-weekday lesson at once.
    // Takes explicit ids rather than a seriesId so the reducer deletes exactly
    // what the caller counted and showed in the confirmation, with no chance of
    // the set changing between the two.
    case "DELETE_TT_ENTRIES": {
      const ids = new Set(action.ids || []);
      if (!ids.size) return state;
      return { ...state, timetableEntries: (state.timetableEntries || []).filter(e => !ids.has(e.id)) };
    }

    // ── Assignment attachments (v1.10) ──
    // ADD carries a row the upload already created server-side, so there is no
    // client-generated id here — the storage key and the row id are the same
    // uuid, minted inside uploadAttachment where the object is written.
    case "ADD_ATTACHMENT":
      return { ...state, attachments: [...(state.attachments || []).filter(a => a.id !== action.attachment.id), action.attachment] };
    case "DELETE_ATTACHMENT":
      return { ...state, attachments: (state.attachments || []).filter(a => a.id !== action.id) };

    // ── Commitments (v1.10) ──
    // A blocker: training, a club, a shift. Weekly when `weekday` is a number,
    // one-off when it is null — that null is the switch, so it is preserved
    // rather than defaulted (Number(null) is 0, which is Sunday).
    case "ADD_COMMITMENT": {
      const c = {
        id: action.id || newSyncId(),
        title: (action.title || "").trim(),
        color: action.color || null,
        weekday: action.weekday === null || action.weekday === undefined || action.weekday === ""
          ? null
          : Math.max(0, Math.min(6, Math.round(Number(action.weekday)))),
        startsOn: action.startsOn || "",
        endsOn: action.endsOn || "",
        // v1.14 Item 7b — null is every week, which is what every row written
        // before this field means. Normalised on the way in so no reader has
        // to cope with "1" as a string from a form.
        intervalWeeks: Number(action.intervalWeeks) > 1 ? Math.round(Number(action.intervalWeeks)) : null,
        startTime: action.startTime,
        endTime: action.endTime,
        notes: action.notes || "",
        updatedAt: action.updatedAt || new Date().toISOString(),
      };
      // An end date on a one-off is meaningless and the DB rejects it, and an
      // interval describes a recurrence a one-off does not have.
      if (c.weekday === null) { c.endsOn = ""; c.intervalWeeks = null; }
      return { ...state, commitments: [...(state.commitments || []), c] };
    }
    case "EDIT_COMMITMENT":
      return { ...state, commitments: (state.commitments || []).map(c => {
        if (c.id !== action.id) return c;
        const weekday = action.weekday !== undefined
          ? (action.weekday === null || action.weekday === ""
            ? null
            : Math.max(0, Math.min(6, Math.round(Number(action.weekday)))))
          : c.weekday;
        const next = {
          ...c,
          title: action.title !== undefined ? (action.title || "").trim() : c.title,
          color: action.color !== undefined ? (action.color || null) : c.color,
          weekday,
          startsOn: action.startsOn !== undefined ? (action.startsOn || "") : c.startsOn,
          endsOn: action.endsOn !== undefined ? (action.endsOn || "") : c.endsOn,
          intervalWeeks: action.intervalWeeks !== undefined
            ? (Number(action.intervalWeeks) > 1 ? Math.round(Number(action.intervalWeeks)) : null)
            : (c.intervalWeeks ?? null),
          startTime: action.startTime ?? c.startTime,
          endTime: action.endTime ?? c.endTime,
          notes: action.notes !== undefined ? (action.notes || "") : c.notes,
          updatedAt: new Date().toISOString(),
        };
        if (next.weekday === null) { next.endsOn = ""; next.intervalWeeks = null; }
        return next;
      })};
    case "DELETE_COMMITMENT":
      return { ...state, commitments: (state.commitments || []).filter(c => c.id !== action.id) };

    // ── Settings ──
    // The old form was `action.mode==="us"?"us":"ib"`, which silently coerced
    // any unrecognised mode to 'ib' — a third mode would have vanished with no
    // error anywhere. Validated against the known set instead.
    case "SET_GRADE_MODE":
      return {...state, gradeMode: isGradeMode(action.mode) ? action.mode : state.gradeMode};
    case "SET_CUSTOM_SCALE":
      return {...state, customScale: normalizeScale(action.scale)};
    case "SET_AI_ENABLED": return {...state,aiEnabled:!!action.on};
    case "SET_FOCUS_CHIP": return {...state,focusChip:!!action.on};
    case "SET_FOCUS_PIN": return {...state,focusPin:!!action.on};
    case "SET_PLAN_REMIND": {
      const next = { ...state };
      if (action.lead !== undefined) {
        const n = action.lead === null ? null : Number(action.lead);
        next.planRemindLead = n === null || !Number.isFinite(n) ? null : Math.max(1, Math.min(24*60, Math.round(n)));
      }
      if (action.atStart !== undefined) next.planRemindStart = !!action.atStart;
      return next;
    }
    case "SET_STUDY_UNTIL": {
      // null switches it off. Anything else is clamped into the day: a stray
      // 25:00 would push the free window past midnight and start listing
      // tomorrow morning as tonight.
      const m = action.minutes;
      if (m === null || m === undefined) return {...state, studyUntil:null};
      const n = Number(m);
      if (!Number.isFinite(n)) return state;
      return {...state, studyUntil: Math.max(0, Math.min(24*60, Math.round(n)))};
    }
    case "SET_NOTIF_ENABLED": return {...state,notifEnabled:!!action.on};

    // ── v1.13 Item 1b — notebook ──
    // The content field is the ONLY thing that changes on nearly every
    // keystroke, so UPDATE_NOTE patches rather than replacing: a full-row
    // action would make every edit carry the whole note through the reducer
    // and into the persist effect's dependency comparison.
    case "ADD_NOTE": {
      const n = {
        id: action.note.id || newSyncId(),
        courseId: action.note.courseId ?? null,
        title: action.note.title ?? '',
        lessonDate: action.note.lessonDate ?? null,
        content: action.note.content ?? '',
        // Free placement. `null` for a note nobody has arranged — see
        // features/notebook/layout.js for why an unarranged note stores no
        // layout at all.
        layout: action.note.layout ?? null,
        sessionId: action.note.sessionId ?? null,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      };
      return { ...state, notes: [...(state.notes || []), n] };
    }
    case "UPDATE_NOTE": {
      const notes = (state.notes || []).map((n) => (
        n.id === action.id
          ? { ...n, ...action.patch, updatedAt: new Date().toISOString() }
          : n
      ));
      return { ...state, notes };
    }
    // Soft delete locally too, so the tombstone reaches the outbox and then
    // other devices. A splice here would make the note reappear on the next
    // pull, which is the resurrection bug reconcile.js guards against.
    case "DELETE_NOTE": {
      const notes = (state.notes || []).map((n) => (
        n.id === action.id
          ? { ...n, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
          : n
      ));
      return { ...state, notes };
    }

    // ── v1.13 Tier 2 — attendance (#31) ──
    // Keyed by (entryId, date), not by id: marking the same lesson twice is
    // one fact being corrected, not two records. The reducer enforces that
    // locally so the local list matches what the server's unique index will
    // hold, rather than diverging until the next pull.
    case "SET_ATTENDANCE": {
      const rows = state.attendance || [];
      // Matched on the NATURAL KEY, and deliberately including soft-deleted
      // rows. The server's identity for an attendance fact is
      // (user, timetable_entry, date) — see the unique index in
      // supabase/migrations/20260904_lesson_attendance_natural_key.sql — and it
      // is total, so the database cannot represent a cleared row and a live row
      // for the same lesson at once.
      //
      // This used to skip `deletedAt` rows, so clearing a mark and re-marking
      // it appended a SECOND local row with a fresh uuid for a fact the server
      // stores once. The two identities then disagreed at every layer: the
      // percentage double-counted until the next pull, and the merge layer had
      // to reconcile a pair the server could never send back.
      //
      // Reviving the existing row instead is exactly what `upsertAttendance`
      // does on the server with `deleted_at: null`. One lesson on one date is
      // one row, on both sides.
      const i = rows.findIndex((r) => (
        r.timetableEntryId === action.timetableEntryId && r.date === action.date
      ));
      const now = new Date().toISOString();
      // A null status means "unmark" — the cycle returns to unmarked, and an
      // unmarked lesson must leave NO live row, or it would sit in the
      // denominator as a status the summariser does not recognise.
      if (action.status == null) {
        if (i < 0) return state;
        const next = [...rows];
        next[i] = { ...next[i], deletedAt: now, updatedAt: now };
        return { ...state, attendance: next };
      }
      if (i >= 0) {
        const next = [...rows];
        next[i] = {
          ...next[i],
          status: action.status,
          note: action.note ?? next[i].note ?? null,
          // Revive: without this, re-marking a cleared lesson would update a
          // row that `indexAttendance` still filters out as deleted.
          deletedAt: null,
          updatedAt: now,
        };
        return { ...state, attendance: next };
      }
      return {
        ...state,
        attendance: [...rows, {
          // `action.id` is supplied by the caller so the id enqueued to the
          // outbox is the same one this reducer stores. Attendance.jsx used to
          // read its id back from a memoised pre-dispatch index, which is empty
          // for a new mark — it enqueued `id: undefined` while this minted a
          // different uuid.
          id: action.id || newSyncId(),
          timetableEntryId: action.timetableEntryId,
          date: action.date,
          status: action.status,
          note: action.note ?? null,
          updatedAt: now,
          deletedAt: null,
        }],
      };
    }

    // ── Sync: bulk merge from Supabase pull (LWW logic in merge.js) ──
    case "MERGE_REMOTE":   return applyRemotePull(state, action.remote);

    // v1.3 AUDIT-SD-FSG-2 — full reducer wipe on sign-out so the next signed-in
    // user on a shared device doesn't see user A's courses / assignments /
    // grades / study sessions residing in WebView memory or the persisted
    // localStorage blob. Cloud-side scoping is already correct (outbox.clear
    // runs before the auth round-trip), so this only closes the LOCAL view-only
    // leak. The persist effect re-runs after this dispatch and writes the
    // INITIAL state to studydesk-v1, naturally clearing the previous user's
    // payload from localStorage.
    // Preserve gradeMode and customScale: they are device-level display
    // configuration (which scale the numbers are on), not per-user academic
    // data, so a user on the Finnish 4-10 scale shouldn't lose it every
    // sign-out. Everything else is wiped.
    // aiEnabled is deliberately NOT preserved, and this is not an oversight:
    // it records one person's consent to send their notes to Google. Carrying
    // it across a sign-out would opt the next person in on a device they just
    // signed into, having never been asked. It falls back to INITIAL's false.
    case "RESET_AFTER_SIGNOUT": return { ...INITIAL, gradeMode: state.gradeMode, customScale: state.customScale };

    default: return state;
  }
}
