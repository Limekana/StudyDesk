import { useState, useEffect, useCallback, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import { setLanguage, SUPPORTED_LANGS, LANGUAGE_NAMES } from "./i18n/index.js";
import { useScrollSelectedIntoView } from "./lib/useScrollSelectedIntoView.js";
import { parseLocalDate, toLocalISO, addDays, fmtDate, fmtDateFull, fmtToday, formatLocale } from "./lib/dates.js";
import { pushWidgetSnapshot, consumeWidgetLaunchView, onWidgetNavigate } from "./lib/widgetBridge.js";
import { LocalNotifications } from "@capacitor/local-notifications";
import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { supabase } from "./lib/supabase.js";
import AuthGate from "./features/auth/AuthGate.jsx";
import { isGuestMode, setGuestMode } from "./lib/guestMode.js";
import { scheduleOriginStamp } from "./lib/originMarker.js";
import { watchAppOpens } from "./lib/appOpens.js";
import { refreshEntitlement } from "./lib/entitlement.js";
import TimerPill from "./features/timer/TimerPill.jsx";
import { useAccountAvatar } from "./lib/useAccountAvatar.js";
import ReferralPrompt from "./features/referral/ReferralPrompt.jsx";
import { inheritFromNexus } from "./lib/suiteSso.js";
import { hydrateOnboardedFromCloud, markOnboardedCloud } from "./lib/onboardingCloud.js";
import * as sync from "./lib/sync.js";
import * as outbox from "./lib/outbox.js";
import { reconcileUnsynced } from "./lib/reconcile.js";
import { applyRemotePull } from "./lib/merge.js";
import GradesView from "./features/grades/GradesView.jsx";
import SessionsView from "./features/sessions/SessionsView.jsx";
import SaveSessionSheet from "./features/sessions/SaveSessionSheet.jsx";
import { isGradeMode, normalizeScale, DEFAULT_CUSTOM_SCALE } from "./lib/gradeScale.js";
import CoursePicker from "./lib/CoursePicker.jsx";
import { ASSIGN_TYPES, OTHER_ASSIGN_TYPE } from "./lib/assignTypes.js";
import { DIFFICULTY_DAYS, DIFFICULTY_COLORS } from "./lib/examDifficulty.js";
import { AddAsgnModal, AddExamModal, EditCourseModal } from "./features/plan/CourseModals.jsx";
import TimerView from "./features/timer/TimerView.jsx";
// Cascade order preserved from the old css+css2+css3+css4+cssOnboard concat.
import './styles/base.css';
import './styles/forms.css';
import './styles/cards.css';
import './styles/onboarding.css';
// v1.9 Item 14a — imported at the shell so the print rules apply to every
// screen, not only the ones that offer a print button.
import './styles/print.css';
import './styles/desktop.css';
import { COURSE_COLORS } from "./lib/courseColors.js";
import { NotebookPen, CalendarDays, Award, Timer, PanelLeftClose, PanelLeftOpen, Paperclip } from "lucide-react";
import { GuestAvatar, AccountAvatar } from "./lib/avatar.jsx";
import { useShellTier, useSidebarRail } from "./lib/useShell.js";
import { startPlanReminderLoop, webNotifySupported } from "./lib/webNotify.js";
import StatsView from "./features/stats/StatsView.jsx";
import CalendarView from "./features/calendar/CalendarView.jsx";
import AnalyticsView from "./features/analytics/AnalyticsView.jsx";
import TimetableView from "./features/timetable/TimetableView.jsx";
import AttachmentList from "./features/plan/Attachments.jsx";
import { useAttachmentDrop } from "./features/plan/useAttachmentDrop.js";
import SettingsView from "./features/settings/SettingsView.jsx";
import { enterSubmit } from "./lib/imeSubmit.js";

// v1.3.1 — initials for the top-right profile avatar (opens Settings, like NCC).
// Derives 1–2 letters from the signed-in email's local part; guests get "·".
const BUCKETS = ["today", "this_week", "later"];
const BUCKET_LABELS = { today: "TODAY", this_week: "THIS WEEK", later: "LATER" };
const BUCKET_COLORS = {
  today:     { bg: "#c0392b", text: "#fff" },
  this_week: { bg: "#d4860a", text: "#fff" },
  later:     { bg: "#2e7d52", text: "#fff" },
};
/** Sentinel preset that reveals the free-text label field (v1.8). Never stored
 *  as an assignment's type — the user's own label is stored instead. */
const DIFFICULTY_LABELS = { easy:"Easy", medium:"Medium", hard:"Hard", brutal:"Brutal" };
const POMO_PRESETS = { focus:25, short:5, long:15 };

// Local midnight for "today", computed PER CALL — never frozen at module load.
// A Capacitor WebView backgrounded overnight and resumed without a cold restart
// would otherwise still think it's yesterday, mis-bucketing an assignment due
// "today" into "later" and staling every due-date urgency calc.
function todayMidnight(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
// IDs that flow into Supabase MUST be proper UUIDs — the columns are typed `uuid`.
// `uid()` above produces short nanoid-style strings (~12 chars) which Postgres rejects.
// Keep `uid()` for local-only entities (assignments, exams, exam topics, actions);
// use `newSyncId()` for everything that crosses the sync boundary (subjects, grades,
// study sessions). Browser-native, no extra dep.
function newSyncId() { return crypto.randomUUID(); }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function daysUntil(s){ if(!s) return null; return Math.round((parseLocalDate(s)-todayMidnight())/86400000); }
function urgencyColor(d){ if(d===null) return "#aaa"; if(d<0) return "#c0392b"; if(d<=2) return "#c0392b"; if(d<=7) return "#d4860a"; return "#2e7d52"; }
function urgencyLabel(d, t){ if(d===null||!t) return ""; if(d<0) return t('av.urgency.overdue',{n:Math.abs(d)}); if(d===0) return t('av.urgency.dueToday'); if(d===1) return t('av.urgency.dueTomorrow'); return t('av.urgency.daysLeft',{n:d}); }
function studyStartDate(e){ return addDays(e.dueDate,-DIFFICULTY_DAYS[e.difficulty||"medium"]); }

// ── Notifications ─────────────────────────────────────────────────────────────
// Action-type IDs for tap-action buttons. Registered once at app start via
// registerActionTypesOnce() and attached per-notification via actionTypeId.
// The button click surfaces as a localNotificationActionPerformed event whose
// actionId === ACTION_DONE_ID and whose notification.extra carries the
// assignmentId to dispatch TOGGLE_ASSIGNMENT against.
const ASSIGNMENT_ACTION_TYPE = "assignment-reminder";
const ACTION_DONE_ID = "done";
let _actionTypesRegistered = false;
async function registerActionTypesOnce() {
  if (_actionTypesRegistered) return;
  try {
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: ASSIGNMENT_ACTION_TYPE,
          actions: [{ id: ACTION_DONE_ID, title: "Mark done" }],
        },
      ],
    });
    _actionTypesRegistered = true;
  } catch (e) {
    console.warn("[StudyDesk] registerActionTypes failed:", e);
  }
}

/** Cancels every pending notification without asking for permission.
 *  Used when reminders are switched off — scheduling and unscheduling must not
 *  share a path, because the scheduling path prompts and the off path must
 *  never prompt. */
async function cancelAllNotifications() {
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
  } catch (e) {
    console.error("[StudyDesk] cancelAllNotifications failed:", e);
  }
}

/** How far ahead planned-session reminders are scheduled, and how many.
 *
 *  Both caps exist because Android holds a finite number of pending alarms per
 *  app (a few hundred) and this function already spends 30 on the daily digest
 *  plus up to three per exam and two per assignment. A user who plans a session
 *  every evening for a term would silently push the exam reminders out of the
 *  queue — the reminders that actually matter. Nearest-first ordering means the
 *  ones that survive the cap are the ones arriving soonest. */
const PLAN_NOTIFY_HORIZON_DAYS = 30;
const PLAN_NOTIFY_MAX = 60;

async function scheduleNotifications(exams, assignments, courses, plannedSessions, planPrefs, t) {
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return;
    // Register action types before scheduling — must be set up before any
    // notification with actionTypeId fires or the button won't render.
    await registerActionTypesOnce();
    // Cancel all previously scheduled notifications before rescheduling
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
    const notes = [];
    const now = Date.now();
    // Use a deterministic ID derived from content so reschedules don't collide
    // IDs must be positive 32-bit integers — use a simple counter seeded > 0
    let id = 1000;

    // ── Daily 9am Next Up digest — fires every day for next 30 days ──
    const topItem = [...exams.filter(e=>!e.done&&e.dueDate), ...assignments.filter(a=>!a.done&&a.dueDate)]
      .sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];
    if (topItem) {
      const topCourse = courses[topItem.courseId];
      const topLabel = topCourse ? `${topItem.title} — ${topCourse.name}` : topItem.title;
      for (let day = 0; day < 30; day++) {
        const at = new Date(); at.setHours(9,0,0,0); at.setDate(at.getDate() + day);
        if (at.getTime() > now) {
          notes.push({ id: id++, title: "📚 StudyDesk — Next Up", body: topLabel, schedule: { at }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
        }
      }
    }

    // ── Exam-specific notifications ──
    exams.forEach(exam => {
      if (exam.done || !exam.dueDate) return;
      const c = courses[exam.courseId];
      const label = c ? `${exam.title} — ${c.name}` : exam.title;
      // Study start day at 9am
      const startAt = parseLocalDate(studyStartDate(exam)); startAt.setHours(9,0,0,0);
      if (startAt.getTime() > now) notes.push({ id: id++, title: "📚 Time to start studying", body: `${label} — ${DIFFICULTY_DAYS[exam.difficulty||"medium"]}d to go`, schedule: { at: startAt }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
      // 2 days before at 9am
      const twoDay = parseLocalDate(addDays(exam.dueDate,-2)); twoDay.setHours(9,0,0,0);
      if (twoDay.getTime() > now) notes.push({ id: id++, title: "⚠️ Exam in 2 days", body: label, schedule: { at: twoDay }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
      // Exam day at 7am
      const examDay = parseLocalDate(exam.dueDate); examDay.setHours(7,0,0,0);
      if (examDay.getTime() > now) notes.push({ id: id++, title: "📝 Exam today — good luck", body: label, schedule: { at: examDay }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
    });

    // ── Assignment-specific notifications ──
    assignments.forEach(asgn => {
      if (asgn.done || !asgn.dueDate) return;
      const c = courses[asgn.courseId];
      const label = c ? `${asgn.title} — ${c.name}` : asgn.title;
      // Day before at 6pm. Action button "Mark done" → TOGGLE_ASSIGNMENT
      // (see App-level useEffect listener). extra.assignmentId carries the
      // target id; both reminders for the same assignment share that id so
      // either notification can mark it done.
      const dayBefore = parseLocalDate(addDays(asgn.dueDate,-1)); dayBefore.setHours(18,0,0,0);
      if (dayBefore.getTime() > now) notes.push({ id: id++, title: "📋 Due tomorrow", body: label, schedule: { at: dayBefore }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62", actionTypeId: ASSIGNMENT_ACTION_TYPE, extra: { assignmentId: asgn.id } });
      // Due day at 9am
      const dueDay = parseLocalDate(asgn.dueDate); dueDay.setHours(9,0,0,0);
      if (dueDay.getTime() > now) notes.push({ id: id++, title: "📋 Due today", body: label, schedule: { at: dueDay }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62", actionTypeId: ASSIGNMENT_ACTION_TYPE, extra: { assignmentId: asgn.id } });
    });

    // ── Planned study sessions (v1.10) ──────────────────────────────────
    //
    // Skips anything already resolved: `fulfilledBy` means the session was
    // logged and `dismissedAt` means it was dropped, and nagging about either
    // is how a reminder system teaches people to ignore it. Skips the past
    // too — a plan whose start time has gone is not upcoming.
    const lead = planPrefs?.lead;
    const wantStart = !!planPrefs?.atStart;
    if (Number.isFinite(lead) || wantStart) {
      const horizon = now + PLAN_NOTIFY_HORIZON_DAYS * 24 * 60 * 60 * 1000;
      const upcoming = (plannedSessions || [])
        .filter((p) => p && p.startsAt && !p.fulfilledBy && !p.dismissedAt && !p.deletedAt)
        .map((p) => ({ p, at: new Date(p.startsAt).getTime() }))
        .filter((x) => Number.isFinite(x.at) && x.at > now && x.at <= horizon)
        .sort((a, b) => a.at - b.at);

      let planned = 0;
      for (const { p, at } of upcoming) {
        if (planned >= PLAN_NOTIFY_MAX) break;
        const c = p.subjectId ? courses[p.subjectId] : null;
        const label = p.title || (c && !c.deletedAt ? c.name : null) || t('notif.planFallback');
        // The lead reminder is dropped, not clamped, when it would land in the
        // past: a plan made 10 minutes before it starts should still get its
        // at-start ping without also firing a "in 30 minutes" one immediately.
        if (Number.isFinite(lead)) {
          const leadAt = at - lead * 60 * 1000;
          if (leadAt > now) {
            notes.push({
              id: id++, title: t('notif.planSoonTitle', { n: lead }), body: label,
              schedule: { at: new Date(leadAt) },
              smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62",
              extra: { view: "timer" },
            });
            planned++;
          }
        }
        if (wantStart && planned < PLAN_NOTIFY_MAX) {
          notes.push({
            id: id++, title: t('notif.planNowTitle'), body: label,
            schedule: { at: new Date(at) },
            smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62",
            extra: { view: "timer" },
          });
          planned++;
        }
      }
    }

    if (notes.length > 0) await LocalNotifications.schedule({ notifications: notes });
  } catch(e) {
    console.error("[StudyDesk] scheduleNotifications failed:", e);
  }
}



const INITIAL = {
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

// ── Onboarding CSS — cream-paper notebook (v1.5.1 design pass) ────────────────
// Direction: editorial / paper. A first-run wizard that feels like opening a
// fresh notebook — ruled lines, a red margin rule, a taped top corner, Playfair
// display ink, and a soft page-settle on each step.

function reducer(state, action) {
  switch(action.type) {
    case "ADD_COURSE":    { const id=action.id||newSyncId(); return {...state,courses:{...state.courses,[id]:{id,name:action.name,color:action.color,notes:[],credits:action.credits??1,semester:action.semester??null,schoolYear:action.schoolYear??null,archivedAt:null,updatedAt:action.updatedAt||new Date().toISOString(),deletedAt:null}}}; }
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
    case "ADD_ASSIGNMENT":  { const a={id:action.id||newSyncId(),courseId:action.courseId,title:action.title,type:action.assignType,dueDate:action.dueDate,notes:action.notes||"",done:false,updatedAt:action.updatedAt||new Date().toISOString()}; return {...state,assignments:[...state.assignments,a]}; }
    case "TOGGLE_ASSIGNMENT": return {...state,assignments:state.assignments.map(a=>a.id===action.id?{...a,done:!a.done,updatedAt:new Date().toISOString()}:a)};
    case "EDIT_ASSIGNMENT":   return {...state,assignments:state.assignments.map(a=>a.id===action.id?{...a,title:action.title,dueDate:action.dueDate,notes:action.notes,updatedAt:new Date().toISOString()}:a)};
    case "DELETE_ASSIGNMENT": return {...state,assignments:state.assignments.filter(a=>a.id!==action.id)};
    case "ADD_EXAM":    { const e={id:action.id||newSyncId(),courseId:action.courseId,title:action.title,dueDate:action.dueDate,difficulty:action.difficulty||"medium",notes:action.notes||"",done:false,topics:[],updatedAt:action.updatedAt||new Date().toISOString()}; return {...state,exams:[...state.exams,e]}; }
    case "TOGGLE_EXAM": return {...state,exams:state.exams.map(e=>e.id===action.id?{...e,done:!e.done,updatedAt:new Date().toISOString()}:e)};
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
        subjectId: action.subjectId || null,
        title: action.title || "",
        weekday: Math.max(0, Math.min(6, Math.round(Number(action.weekday)))),
        startsAt: action.startsAt,
        endsAt: action.endsAt,
        room: action.room || "",
        color: action.color || null,
        updatedAt: action.updatedAt || new Date().toISOString(),
      };
      return { ...state, timetableEntries: [...(state.timetableEntries || []), e] };
    }
    case "EDIT_TT_ENTRY":
      return { ...state, timetableEntries: (state.timetableEntries || []).map(e => e.id !== action.id ? e : {
        ...e,
        subjectId: action.subjectId !== undefined ? (action.subjectId || null) : e.subjectId,
        title: action.title !== undefined ? (action.title || "") : e.title,
        weekday: action.weekday !== undefined ? Math.max(0, Math.min(6, Math.round(Number(action.weekday)))) : e.weekday,
        startsAt: action.startsAt ?? e.startsAt,
        endsAt: action.endsAt ?? e.endsAt,
        room: action.room !== undefined ? (action.room || "") : e.room,
        color: action.color !== undefined ? (action.color || null) : e.color,
        updatedAt: new Date().toISOString(),
      })};
    case "DELETE_TT_ENTRY":
      return { ...state, timetableEntries: (state.timetableEntries || []).filter(e => e.id !== action.id) };

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
        startTime: action.startTime,
        endTime: action.endTime,
        notes: action.notes || "",
        updatedAt: action.updatedAt || new Date().toISOString(),
      };
      // An end date on a one-off is meaningless and the DB rejects it.
      if (c.weekday === null) c.endsOn = "";
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
          startTime: action.startTime ?? c.startTime,
          endTime: action.endTime ?? c.endTime,
          notes: action.notes !== undefined ? (action.notes || "") : c.notes,
          updatedAt: new Date().toISOString(),
        };
        if (next.weekday === null) next.endsOn = "";
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

// ── CSS ───────────────────────────────────────────────────────────────────────




// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL, (init) => {
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
  });
  const { t } = useTranslation();
  const [onboarded, setOnboarded] = useState(() => {
    try { return localStorage.getItem("studydesk-onboarded") === "1"; } catch { return false; }
  });
  // v1.10 - ask the ACCOUNT whether onboarding is already done, not just this
  // device. The effect that does the asking lives further down, immediately
  // after `session` is declared -- it reads `session`, and a dependency array
  // is evaluated during render, so up here it referenced the binding before
  // its useState had run.
  const [onboardChecked, setOnboardChecked] = useState(false);
  useEffect(() => {
    try { localStorage.setItem("studydesk-v1", JSON.stringify({
      courses:state.courses,
      assignments:state.assignments,
      actions:state.actions,
      exams:state.exams,
      grades:state.grades,
      studySessions:state.studySessions,
      plannedSessions:state.plannedSessions,
      academicTerms:state.academicTerms,
      timetableEntries:state.timetableEntries,
      attachments:state.attachments,
      commitments:state.commitments,
    })); } catch {}
  }, [state.courses,state.assignments,state.actions,state.exams,state.grades,state.studySessions,state.plannedSessions,state.academicTerms,state.timetableEntries,state.attachments,state.commitments]);
  // gradeMode is UI-only — persist separately so it doesn't trigger a v1 rewrite on every toggle.
  useEffect(() => {
    try { localStorage.setItem("studydesk-grade-mode", state.gradeMode); } catch {}
  }, [state.gradeMode]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-grade-scale", JSON.stringify(state.customScale)); } catch {}
  }, [state.customScale]);
  // Same treatment for the AI opt-in: device-level, not synced academic data.
  useEffect(() => {
    try { localStorage.setItem("studydesk-ai-enabled", state.aiEnabled ? "1" : "0"); } catch {}
  }, [state.aiEnabled]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-focus-chip", state.focusChip ? "1" : "0"); } catch {}
  }, [state.focusChip]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-focus-pin", state.focusPin ? "1" : "0"); } catch {}
  }, [state.focusPin]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-notifications", state.notifEnabled ? "1" : "0"); } catch {}
  }, [state.notifEnabled]);
  useEffect(() => {
    try {
      localStorage.setItem("studydesk-study-until", state.studyUntil === null ? "off" : String(state.studyUntil));
    } catch {}
  }, [state.studyUntil]);
  useEffect(() => {
    try {
      localStorage.setItem("studydesk-plan-lead", state.planRemindLead === null ? "off" : String(state.planRemindLead));
      localStorage.setItem("studydesk-plan-start", state.planRemindStart ? "1" : "0");
    } catch {}
  }, [state.planRemindLead, state.planRemindStart]);

  // Schedule notifications after onboarding with fresh state (#21 fix)
  // Reschedule notifications whenever exams or assignments change (not just onboarding)
  useEffect(() => {
    if (!onboarded) return;
    // notifEnabled is what makes "Maybe later" mean anything. Before this gate
    // both onboarding buttons ran the same path, so declining still reached
    // scheduleNotifications — which calls requestPermissions() and therefore
    // raised the very OS prompt the user had just declined.
    if (state.notifEnabled) {
      scheduleNotifications(
        state.exams, state.assignments, state.courses,
        state.plannedSessions,
        { lead: state.planRemindLead, atStart: state.planRemindStart },
        t,
      );
    } else {
      // Turning them off must also clear anything already scheduled, or
      // reminders keep arriving from a previous session's schedule.
      cancelAllNotifications();
    }
    // state.courses belongs here: notification bodies carry the course name, so
    // renaming a course left stale text scheduled until an exam or assignment
    // happened to change.
    // plannedSessions and both reminder prefs belong here for the same reason
    // state.courses does: the schedule is derived from them, so changing one
    // without rescheduling leaves the OS holding a stale set of alarms.
  }, [onboarded, state.notifEnabled, state.exams, state.assignments, state.courses,
      state.plannedSessions, state.planRemindLead, state.planRemindStart, t]);

  // ── Web reminders (v1.10) ────────────────────────────────────────────────
  //
  // Android gets OS alarms through LocalNotifications; the browser has no
  // equivalent, so on web the same two preferences are served by a polling
  // loop. See lib/webNotify.js for why it polls rather than setTimeout, and
  // for the honest limit: this fires while StudyDesk is OPEN in a tab, hidden
  // or minimised included, and cannot fire once the tab is closed.
  //
  // The loop reads through a ref so it is started once. Passing state directly
  // would rebuild it on every plan edit and every keystroke in Settings, which
  // resets the tick and drops whatever was about to fire.
  const webNotifyState = useRef(null);
  webNotifyState.current = {
    enabled: onboarded && state.notifEnabled,
    plans: state.plannedSessions,
    courses: state.courses,
    prefs: { lead: state.planRemindLead, atStart: state.planRemindStart },
    labels: {
      fallback: t('notif.planFallback'),
      now: t('notif.planNowTitle'),
      soon: (n) => t('notif.planSoonTitle', { n }),
    },
  };
  useEffect(() => {
    if (Capacitor.isNativePlatform() || !webNotifySupported()) return undefined;
    return startPlanReminderLoop(() => webNotifyState.current);
  }, []);

  // v1.9 (Item 8) — keep the home-screen widgets in step with the same data,
  // on the same triggers as the notifications above. Both answer "what's next"
  // from outside the app, so they should never be able to disagree.
  //
  // Not gated on notifEnabled: a widget the user chose to place on their home
  // screen is not a notification, and declining reminders is not declining it.
  // The push itself no-ops off Android and when no widget is placed.
  useEffect(() => {
    void pushWidgetSnapshot({
      assignments: state.assignments,
      exams: state.exams,
      courses: state.courses,
      t,
      locale: formatLocale(),
    });
  }, [state.assignments, state.exams, state.courses, t]);

  // v1.10 — widget taps land where the widget was about.
  //
  // Shipped 1.7.0 gave both widgets the same bare "open MainActivity" intent,
  // so a tap dropped the user on whatever screen they last left the app on —
  // reported as "doesnt take me to the right place both just open the app".
  // Next Up now opens the Next Up view, Upcoming opens the plan view.
  //
  // Two paths because Android delivers the two cases differently: a cold start
  // is queued natively and collected here on mount, a tap while the app is
  // already running arrives as an event. See WidgetBridgePlugin.
  useEffect(() => {
    let cancelled = false;

    void consumeWidgetLaunchView().then((view) => {
      if (!cancelled && view) dispatch({ type: "SET_VIEW", view });
    });

    // Await the handle before removing it — the same StrictMode ordering trap
    // that double-registered the notification listener in v1.7.
    const handlePromise = onWidgetNavigate((view) => {
      dispatch({ type: "SET_VIEW", view });
    });

    return () => {
      cancelled = true;
      void handlePromise?.then((h) => h.remove()).catch(() => {});
    };
  }, []);

  // v1.3 — outbox drain triggers. The outbox holds pending Supabase writes
  // when the device is offline or a sync call failed; this effect re-runs
  // drain on three signals:
  //
  //   1. App cold-start (mount) — catches anything queued in a prior
  //      session that hadn't drained yet.
  //   2. `online` window event — fires when the OS detects network
  //      restoration. Capacitor surfaces this in the Android WebView.
  //   3. `visibilitychange` → visible — fires when the app comes back to
  //      the foreground after being backgrounded. Capacitor maps Android's
  //      onResume here. Useful when the device was online but the user
  //      was away long enough for a retry to make sense.
  //
  // drain() is single-flight inside the outbox (coalesces overlapping
  // calls) so firing it from all three paths is safe.
  useEffect(() => {
    // One-shot on mount.
    void outbox.drain();
    function onOnline() { void outbox.drain(); }
    function onVisibility() {
      if (document.visibilityState === 'visible') void outbox.drain();
    }
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Listen for "Mark done" action-button taps on assignment reminders.
  // The handler dispatches TOGGLE_ASSIGNMENT — since reschedules filter out
  // assignments where done===true, the next scheduling pass naturally drops
  // any further reminders for the just-completed assignment. The reducer's
  // toggle (rather than a one-way mark-done) is fine here because Android
  // auto-dismisses the notification on action tap, so accidental
  // double-taps that would un-toggle aren't reachable.
  useEffect(() => {
    // Hold the listener PROMISE and remove via it. With the old
    // `let handle=null; (async)=>{handle=await add()}` pattern, React 19
    // StrictMode's mount→cleanup→mount runs cleanup before the await resolves
    // (handle still null → .remove() skipped), orphaning the first listener and
    // double-registering — so "Mark done" fired TOGGLE_ASSIGNMENT twice (net
    // no-op). The backButton listener below already uses this safe idiom.
    const handlePromise = LocalNotifications.addListener(
          "localNotificationActionPerformed",
          (event) => {
            // v1.3.1 BUG-14 — body-tap navigation. @capacitor/local-notifications
            // fires this same event for both the "Mark done" action button AND
            // a tap on the notification body itself (actionId === 'tap'). The
            // existing handler only acted on 'done'; body taps fell through and
            // the app opened on whatever screen it was last on instead of the
            // relevant assignments view. Route body taps to the plan view so
            // the user lands on the full assignment list — same target as the
            // ActionsView ("Next Up") would imply but "plan" surfaces all
            // upcoming work, which matches the tap intent better.
            if (event.actionId === "tap") {
              dispatch({ type: "SET_VIEW", view: "plan" });
              return;
            }
            if (event.actionId !== ACTION_DONE_ID) return;
            const assignmentId = event.notification?.extra?.assignmentId;
            if (!assignmentId) return;
            dispatch({ type: "TOGGLE_ASSIGNMENT", id: assignmentId });
          },
        );
    handlePromise.catch((e) => console.warn("[StudyDesk] action listener failed:", e));
    return () => { handlePromise.then((h) => h.remove()).catch(() => {}); };
  }, []);
  // Notifications are only scheduled after onboarding completes — never on first open
  const handleOnboardingComplete = useCallback((courseData, opts = {}) => {
    if (courseData) {
      dispatch({type:"ADD_COURSE", name:courseData.name, color:courseData.color});
    }
    // `notifications` carries which of the two step-3 buttons was pressed.
    // Default true so any caller that omits it (or a skip that never reaches
    // step 3) behaves as before; only an explicit false opts out.
    dispatch({type:"SET_NOTIF_ENABLED", on: opts.notifications !== false});
    try { localStorage.setItem("studydesk-onboarded","1"); } catch {}
    void markOnboardedCloud();
    setOnboarded(true);
    // Notifications scheduled via useEffect watching onboarded — avoids stale closure (#21)
  }, []);

  const [flash, setFlash] = useState(null);
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [showAddAsgn, setShowAddAsgn] = useState(false);
  const [showAddExam, setShowAddExam] = useState(false);
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseColor, setNewCourseColor] = useState(COURSE_COLORS[0]);
  const showFlash = useCallback((msg) => { setFlash(msg); setTimeout(()=>setFlash(null),2200); }, []);

  // ── Auth session ─────────────────────────────────────────────────────────────
  const [session, setSession] = useState(undefined); // undefined = loading; null = signed out; object = signed in
  // v1.1 — guest mode flag. When `session === null` AND `guest === true`, the
  // app renders normally with cloud sync disabled (Supabase realtime + outbox
  // are already session-gated, so this is a pure UI bypass — no other code
  // changes needed). When the user signs in or signs out, the flag is cleared.
  const [guest, setGuest] = useState(() => isGuestMode());

  // v1.10 - the account-level onboarding check. Declared HERE, below `session`,
  // rather than beside the `onboardChecked` state it drives: the dependency
  // array `[session]` is evaluated on every render, so with this block above
  // `const [session, ...] = useState(...)` it read `session` inside its
  // temporal dead zone and threw "Cannot access 'session' before
  // initialization", blanking the app on first paint.
  //
  // That failure was invisible to `npm run build` and to eslint, and did not
  // reproduce under `npm run dev` -- only a production preview of the built
  // bundle showed it. Keep this effect below the declaration.
  //
  // Gated so a signed-in user never sees a frame of the wizard before the
  // answer lands; a guest or signed-out user resolves immediately, because
  // there is no account to ask.
  useEffect(() => {
    if (session === undefined) return;   // auth still resolving
    if (!session) { setOnboardChecked(true); return; }
    let cancelled = false;
    setOnboardChecked(false);
    hydrateOnboardedFromCloud().then((done) => {
      if (cancelled) return;
      if (done) setOnboarded(true);
      setOnboardChecked(true);
    });
    return () => { cancelled = true; };
  }, [session]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let { data } = await supabase.auth.getSession();

      // v1.1 — auto-inherit from NCC on cold start when no local session.
      //
      // Why: Supabase rotates refresh_tokens on every refresh. NCC and
      // StudyDesk share ONE logical session via the SSO bundle but each
      // app's supabase client persists its own copy. When NCC's background
      // auto-refresh rotates the token, StudyDesk's stored refresh_token
      // becomes stale; its next refresh attempt fails; onAuthStateChange
      // fires SIGNED_OUT. Symptom: every cold start lands the user on
      // AuthGate needing to tap Continue with Nexus again.
      //
      // Fix: when getSession() returns null, probe NCC's ContentProvider
      // and silently inherit. As long as NCC is signed in, this re-syncs
      // StudyDesk to the latest published bundle without user-visible
      // re-auth. Guest mode and the web platform short-circuit this path.
      if (!data.session && !isGuestMode() && Capacitor.isNativePlatform()) {
        try {
          const result = await inheritFromNexus();
          if (result.ok) {
            ({ data } = await supabase.auth.getSession());
          }
        } catch (e) {
          console.warn("[studydesk] auto-inherit on init failed:", e);
        }
      }

      if (!cancelled) setSession(data.session);
      // ACT-5 — cover the restored-session path too, not just fresh sign-ins.
      // Every account that predates this instrumentation only ever appears here.
      scheduleOriginStamp(data.session?.user ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      scheduleOriginStamp(s?.user ?? null);
      // v1.1 — any successful sign-in clears guestMode so the user resumes
      // normal session-based flow. Without this, a user who signed out
      // (which sets guestMode=true to prevent next-launch auto-inherit
      // undoing the sign-out) and later signs back in would keep
      // guestMode=true. The gate would still work (session wins), but if
      // the session expired the next cold start would silently land them
      // in guest mode rather than attempting auto-inherit. Centralizing
      // the clear here means every sign-in path (Nexus inherit, Google,
      // email, restored session) converges to the same state.
      if (event === "SIGNED_IN") {
        setGuestMode(false);
        window.dispatchEvent(new CustomEvent("studydesk:guest-mode-changed"));
      }
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);
  // Listen for guest-mode flag changes triggered by AuthGate (set) or the
  // sign-out path below (clear). localStorage doesn't emit change events
  // within the same tab, so we use a CustomEvent contract on `window`.
  useEffect(() => {
    const onChange = () => setGuest(isGuestMode());
    window.addEventListener("studydesk:guest-mode-changed", onChange);
    return () => window.removeEventListener("studydesk:guest-mode-changed", onChange);
  }, []);

  // v1.7 — true once the first pull of this session has settled. The push
  // reconciler below stays disarmed until then.
  const pulledOnceRef = useRef(false);

  // The pull effect below deliberately re-subscribes only when the user id
  // changes, so its closure holds a stale `state`. The reconcile needs the
  // CURRENT local rows to diff against what the pull returned — hence a ref.
  // Written in an effect rather than during render: refs must not be mutated
  // while rendering, and this commits before any pull callback can resolve.
  // v1.12 Item 9 — the topbar avatar must show what the user actually chose,
  // not just their initials. Re-resolves on any profile edit.
  const accountAvatar = useAccountAvatar(session);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });

  // ── Sync: initial pull + Realtime, gated on sign-in ─────────────────────────
  useEffect(() => {
    if (!session) { sync.stopRealtime(); pulledOnceRef.current = false; return; }
    let cancelled = false;
    const doPull = async () => {
      try {
        const remote = await sync.pullAllStudyData();
        if (!cancelled) dispatch({ type: "MERGE_REMOTE", remote });
        // v1.12 Item 1 (#38) — repair rows that never reached the server.
        // Every enqueue site is gated on `session`, so anything written while
        // the session was null (every cold start; and for hours a day under
        // `SESS-1`) was dropped rather than queued, with no path back. Diffing
        // local against the pull is what finds them; `outbox.drain`'s
        // dependency ranking is what lets a rescued course push before the
        // exams that have been failing on its foreign key.
        //
        // Runs against the PRE-merge local state on purpose: the merge only
        // adds remote rows, and local-only is precisely what we are looking
        // for. Cheap when there is nothing to do — two set builds and a walk.
        if (!cancelled) {
          const queued = reconcileUnsynced(stateRef.current, remote, outbox);
          if (queued) console.warn(`[StudyDesk] reconcile: re-queued ${queued} unsynced row(s)`);
        }
      } catch (e) {
        console.error("[StudyDesk] pull failed:", e);
      } finally {
        // v1.7 — arm the push reconciler on SETTLE, not on success. If the pull
        // failed we still want later local edits to sync; blocking on a healthy
        // pull would mean one flaky launch silently stops pushing for the whole
        // session. LWW plus the outbox already handle a stale starting point.
        if (!cancelled) pulledOnceRef.current = true;
      }
    };
    doPull();
    sync.startRealtime(doPull);
    return () => { cancelled = true; sync.stopRealtime(); };
  // Only re-subscribe when the signed-in user id changes — not on every
  // session refresh (token refresh shouldn't tear down Realtime).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // ── Save-session sheet (raised when timer's focus phase ends) ───────────────
  const [pendingSession, setPendingSession] = useState(null); // { durationMinutes, task, startedAt } | null
  // v1.3 — sub-tab within the Timer view (Timer / Log / Stats), so Log + Stats
  // don't need their own bottom-bar slots.
  const [timerSub, setTimerSub] = useState("timer");
  // v1.9 Item 14a — sub-tab within Plan (List / Calendar), same shape as the
  // Timer hub above rather than a fifth bottom tab: the four-tab bar was sized
  // and tuned in v1.9 Item 6 against the longest label the app ships, and a
  // fifth slot would undo that on a 360px screen.
  //
  // `null` means "follow the tier" — the calendar is the point of a wide
  // screen, and the list is the better read on a phone. Once the user picks
  // one, their choice wins at every width. Same 'auto until you touch it'
  // semantics as the sidebar rail, so the two preferences behave alike.
  const [planSubPref, setPlanSubPref] = useState(() => {
    try {
      const v = localStorage.getItem("studydesk-plan-sub");
      // v1.10 adds "timetable". An unrecognised value falls back to null (=
      // follow the tier) rather than being written through, so a downgrade
      // leaves a working screen instead of an empty sub-tab.
      return v === "list" || v === "calendar" || v === "timetable" ? v : null;
    } catch { return null; }
  });
  // v1.9 Item 14a — Grades / Trends. Not tier-defaulted like the Plan sub-tab:
  // the grade list is the answer to "what did I get", which is what this screen
  // is opened for at every width; Trends is the follow-up question.
  const [gradesSub, setGradesSub] = useState("grades");
  const choosePlanSub = useCallback((v) => {
    try { localStorage.setItem("studydesk-plan-sub", v); } catch { /* private mode */ }
    setPlanSubPref(v);
  }, []);
  // Stale persisted nav: pre-v1.3 builds could have state.view === "log"/"stats"
  // (now removed as top-level views). Re-home them into the Timer hub so the
  // routed area never renders blank after upgrading.
  useEffect(() => {
    if (state.view === "log" || state.view === "stats") {
      setTimerSub(state.view);
      dispatch({ type: "SET_VIEW", view: "timer" });
    }
  }, [state.view]);

  // ── v1.0.4 one-shot post-migration push ─────────────────────────────────────
  // The UUID migration in the reducer init may have rewritten local IDs. Those
  // rewritten rows have never reached Supabase (the old short-ID pushes were
  // failing silently). Push everything once after sign-in. Subjects must go
  // before grades (FK), grades before sessions doesn't matter (no FK between).
  // Fire-and-forget per row, log failures — next user edit will retry.
  useEffect(() => {
    if (!session) return;
    if (localStorage.getItem("studydesk-needs-initial-push") !== "1") return;
    let cancelled = false;
    (async () => {
      let pushed = 0, failed = 0;
      const courses = Object.values(state.courses).filter(c => !c.deletedAt);
      for (const c of courses) {
        if (cancelled) return;
        try {
          await sync.upsertSubject({ id: c.id, name: c.name, credits: c.credits, semester: c.semester, schoolYear: c.schoolYear, color: c.color });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push subject failed:", c.id, e); }
      }
      const grades = (state.grades || []).filter(g => !g.deletedAt);
      for (const g of grades) {
        if (cancelled) return;
        try {
          await sync.upsertGrade({ id: g.id, subjectId: g.subjectId, grade: g.grade, weight: g.weight, date: g.date });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push grade failed:", g.id, e); }
      }
      const sessions = (state.studySessions || []).filter(s => !s.deletedAt);
      for (const s of sessions) {
        if (cancelled) return;
        try {
          await sync.logStudySession({ id: s.id, subjectId: s.subjectId, startedAt: s.startedAt, durationMinutes: s.durationMinutes, notes: s.notes });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push session failed:", s.id, e); }
      }
      // v1.7 (StudyDesk#6) — assignments/exams/actions. These run AFTER courses
      // because both carry a NOT NULL subject_id FK; a course that failed above
      // would take its homework down with it, which is why failures are counted
      // rather than thrown (the flag stays set and the whole batch retries).
      // Rows whose course no longer exists locally are skipped rather than
      // attempted: the FK would reject them and burn a retry every launch.
      for (const a of (state.assignments || [])) {
        if (cancelled) return;
        if (!a.courseId || !state.courses[a.courseId]) continue;
        try {
          await sync.upsertAssignment({ id: a.id, courseId: a.courseId, title: a.title, type: a.type, dueDate: a.dueDate, notes: a.notes, done: a.done });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push assignment failed:", a.id, e); }
      }
      for (const ex of (state.exams || [])) {
        if (cancelled) return;
        if (!ex.courseId || !state.courses[ex.courseId]) continue;
        try {
          await sync.upsertExam({ id: ex.id, courseId: ex.courseId, title: ex.title, dueDate: ex.dueDate, difficulty: ex.difficulty, notes: ex.notes, done: ex.done, topics: ex.topics });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push exam failed:", ex.id, e); }
      }
      // Only manual to-dos. The suggested ones are derived from assignments and
      // exams on every render and must never reach the cloud, or they would
      // come back as duplicate real rows alongside the freshly derived ones.
      for (const ac of (state.actions || []).filter(x => !x.suggested)) {
        if (cancelled) return;
        try {
          await sync.upsertAction({ id: ac.id, text: ac.text, bucket: ac.bucket, courseId: ac.courseId, done: ac.done });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push action failed:", ac.id, e); }
      }
      if (failed === 0) {
        try { localStorage.removeItem("studydesk-needs-initial-push"); } catch {}
        if (pushed > 0) showFlash(t('av.flash.syncedLegacy', { n: pushed }));
      } else {
        showFlash(t('av.flash.syncedFailed', { pushed, failed }));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // ── v1.7 push reconciler for assignments / exams / actions (StudyDesk#6) ────
  //
  // Courses, grades and sessions enqueue their own pushes at each call site.
  // These three deliberately do not, and the reason is structural: they are
  // mutated from ~15 places across AsgnItem, ExamCard and ActionsView, none of
  // which receive `session`. Threading it through every one of those props
  // would be a wide change to working components, and any call site missed
  // would be an edit that silently never syncs — the exact bug being fixed.
  //
  // Instead: diff the three arrays after every state change and enqueue what
  // actually moved. One place, no call sites to miss, and it picks up any
  // future mutation path for free.
  const pushBaseline = useRef(null);
  useEffect(() => {
    if (!session) { pushBaseline.current = null; return; }
    // Wait for the first pull to settle before arming. Pushing local rows
    // before knowing the remote state would stamp them updated_at = now and
    // let a stale device win against a newer edit made elsewhere.
    if (!pulledOnceRef.current) return;

    const snap = (list, fields) => {
      const m = new Map();
      for (const x of list || []) m.set(x.id, fields(x));
      return m;
    };
    // Compare on updatedAt, not deep equality — every mutation stamps it, so
    // this is both cheaper and immune to unrelated field churn.
    const stamp = (x) => x.updatedAt || '';
    const next = {
      assignments: snap(state.assignments, stamp),
      exams: snap(state.exams, stamp),
      actions: snap((state.actions || []).filter((a) => !a.suggested), stamp),
    };

    // First run after a pull: record the baseline, push nothing. What is on
    // screen right now is already reconciled with the cloud.
    if (!pushBaseline.current) { pushBaseline.current = next; return; }

    const prev = pushBaseline.current;
    const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
    const assignmentsById = byId(state.assignments);
    const examsById = byId(state.exams);
    const actionsById = byId(state.actions);

    for (const [id, s] of next.assignments) {
      if (prev.assignments.get(id) === s) continue;
      const a = assignmentsById.get(id);
      if (!a?.courseId) continue;
      outbox.enqueue('upsert_assignment', { id, courseId: a.courseId, title: a.title, type: a.type, dueDate: a.dueDate, notes: a.notes, done: a.done });
    }
    for (const id of prev.assignments.keys()) {
      if (!next.assignments.has(id)) outbox.enqueue('delete_assignment', { id });
    }

    for (const [id, s] of next.exams) {
      if (prev.exams.get(id) === s) continue;
      const e = examsById.get(id);
      if (!e?.courseId) continue;
      outbox.enqueue('upsert_exam', { id, courseId: e.courseId, title: e.title, dueDate: e.dueDate, difficulty: e.difficulty, notes: e.notes, done: e.done, topics: e.topics });
    }
    for (const id of prev.exams.keys()) {
      if (!next.exams.has(id)) outbox.enqueue('delete_exam', { id });
    }

    for (const [id, s] of next.actions) {
      if (prev.actions.get(id) === s) continue;
      const a = actionsById.get(id);
      if (!a) continue;
      outbox.enqueue('upsert_action', { id, text: a.text, bucket: a.bucket, courseId: a.courseId, done: a.done });
    }
    for (const id of prev.actions.keys()) {
      if (!next.actions.has(id)) outbox.enqueue('delete_action', { id });
    }

    pushBaseline.current = next;
  // `session` is read for the sign-in gate only; the identity that matters is
  // the user id, which the pull effect already keys on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, state.assignments, state.exams, state.actions]);

  // NOTE: the sign-out handler lives in SettingsView.onSignOut (identical logic
  // incl. the guestMode=true anti-auto-re-sign-in fix). An earlier duplicate
  // copy here was dead (never wired to a control) and was removed in the v1.7
  // audit to avoid two divergent sign-out paths.

  // v1.12 Item 0 — retention. Mount-only and deliberately independent of the
  // auth effect: the trigger is the app being foregrounded, not a session
  // arriving. Guests and same-day repeats are filtered inside recordAppOpen.
  useEffect(() => watchAppOpens(), []);

  // v1.12 Item 5 — supporter entitlement. Keyed on the user id rather than the
  // session object so a token refresh does not re-ask; `refreshEntitlement`
  // additionally serves from cache for six hours, so this is close to free on
  // an ordinary launch. A network failure keeps whatever was cached — losing a
  // supporter's perk because their train went into a tunnel is the wrong
  // failure mode, and the module is written that way deliberately.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    void refreshEntitlement(uid);
  }, [session?.user?.id]);

  // #26 — Android back button: dismiss modals first, then navigate home, then exit
  useEffect(() => {
    const handler = CapApp.addListener("backButton", () => {
      if (showAddCourse||showAddAsgn||showAddExam||editingCourse) {
        setShowAddCourse(false); setShowAddAsgn(false); setShowAddExam(false); setEditingCourse(null);
      } else if (state.view !== "actions") {
        dispatch({type:"SET_VIEW", view:"actions"});
      } else {
        CapApp.exitApp();
      }
    });
    return () => { handler.then(h=>h.remove()); };
  }, [showAddCourse,showAddAsgn,showAddExam,editingCourse,state.view]);
  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
  const todayStr = fmtToday();
  const urgent = state.assignments.filter(a=>{ if(a.done) return false; const d=daysUntil(a.dueDate); return d!==null&&d<=0; });
  const urgentExams = state.exams.filter(e=>!e.done&&daysUntil(e.dueDate)!==null&&daysUntil(e.dueDate)<=3);
  const addCourse = () => {
    if(!newCourseName.trim()) return;
    const id = newSyncId();
    const name = newCourseName.trim();
    const color = newCourseColor;
    dispatch({type:"ADD_COURSE", id, name, color});
    // Advance to the next preset so adding several courses in a row gives each
    // a different colour — what the old index-based picker did with
    // setColorIdx(i => i + 1). A custom colour is not in the list, so indexOf
    // returns -1 and this lands on COURSE_COLORS[0]: a deliberate reset rather
    // than carrying a one-off colour into the next course.
    setNewCourseColor(COURSE_COLORS[(COURSE_COLORS.indexOf(color) + 1) % COURSE_COLORS.length]);
    setNewCourseName(""); setShowAddCourse(false); showFlash(t('av.flash.courseAdded'));
    if (session) outbox.enqueue("upsert_subject", { id, name, color });
  };

  // v1.9 (Item 14, Phase 1) — desktop shell. `tier` is phone/tablet/desktop;
  // `rail` is whether the sidebar is the 64px icon rail. Declared here rather
  // than lower down because the early returns below (auth gate, loading) must
  // not sit between a hook and its call site.
  const shellTier = useShellTier();
  const [rail, toggleRail] = useSidebarRail(shellTier);
  // Resolved here rather than stored, so a user who has never chosen follows
  // the tier as it changes (resizing a window, rotating a tablet) instead of
  // being pinned to whatever tier they first loaded at.
  const planSub = planSubPref ?? (shellTier === "desktop" ? "calendar" : "list");

  // v1.9 (Item 6) — icons are back, but not the ones that were dropped.
  // SD-F2 removed a set of emoji/text glyphs in v1.6.0 because they were
  // inconsistent and crowded the label. These are lucide line icons at the
  // size and stroke weight LimeLog uses, which is the treatment the suite is
  // converging on. The labels stay: they carry the nav, the icon supports it.
  const views = [
    {id:"actions",  label:t('nav.study'),  Icon:NotebookPen},
    {id:"plan",     label:t('nav.plan'),   Icon:CalendarDays},
    // Award rather than a chart: Grades is where a result lands, and the
    // chart reading already belongs to the Stats sub-tab under Timer.
    {id:"grades",   label:t('nav.grades'), Icon:Award},
    // v1.3 — Timer now hosts Log + Stats as sub-tabs (see TimerView), so they
    // no longer take their own bottom-bar slots — keeps the nav uncrowded.
    {id:"timer",    label:t('nav.timer'),  Icon:Timer},
    // v1.3.1 — Settings is no longer a nav tab; it opens from the top-right
    // profile avatar (matches NCC/LimeLog). Still a valid `state.view`.
  ];
  const activeView = views.find(v=>v.id===state.view);

  // Auth gate: show login UI until Supabase confirms a session.
  // (session === undefined while the initial getSession() call is in flight.)
  if (session === undefined) {
    return <><div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",letterSpacing:"0.1em"}}>{t('av.chrome.loading')}</div></>;
  }
  // v1.1 — bypass AuthGate when the user opted into guest mode. The rest of
  // the app runs identically; cloud sync remains gated on `session` which is
  // still null, so realtime stays off and outbox enqueue calls are no-ops.
  if (session === null && !guest) {
    return <><AuthGate/></>;
  }

  return (<>
    
    {!onboarded && onboardChecked && <OnboardingView onComplete={handleOnboardingComplete}/>}
    {onboarded && (
      <div className={"app"+(rail?" is-rail":"")} data-tier={shellTier}>
      {/* ── Desktop sidebar ──
          v1.9 Item 14: `.rail-hide` marks everything that has no room in the
          64px icon rail. `aria-label` is unconditional — when railed the label
          text is display:none and would otherwise take the accessible name
          with it — while `title` is added only when railed, since a tooltip
          repeating a label you can already read is just noise. */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo-wrap">
            <img src="/logo.png" alt="StudyDesk" className="sidebar-logo" />
            <div className="rail-hide">
              <div className="sidebar-wordmark">Studydesk</div>
              <div className="sidebar-sub">{t('av.chrome.subtitle')}</div>
            </div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {views.map(v=><div key={v.id} role="button" tabIndex={0} aria-label={v.label} title={rail?v.label:undefined} className={"nav-item"+(state.view===v.id?" active":"")} onClick={()=>dispatch({type:"SET_VIEW",view:v.id})} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:v.id})}>
            {/* The sidebar tracks the mobile bar: it dropped glyphs with it in
                v1.6.0 and takes the lucide icons back with it now. `.nav-item`
                is already a horizontal flex row with a 10px gap, so the icon
                sits inline before the label rather than above it. */}
            <v.Icon size={16} strokeWidth={1.75} aria-hidden="true"/>
            <span className="rail-hide">{v.label}</span>
          </div>)}
        </nav>
        <div className="sidebar-courses">
          {courses.length>0&&<div className="courses-label rail-hide">{t('av.chrome.coursesLabel')}</div>}
          {courses.map(c=>{
            const open=state.assignments.filter(a=>a.courseId===c.id&&!a.done).length;
            const exams=state.exams.filter(e=>e.courseId===c.id&&!e.done).length;
            return <div key={c.id} role="button" tabIndex={0} aria-label={c.name} title={rail?c.name:undefined} className={"course-item"+(state.activeCourse===c.id?" active":"")} onClick={()=>dispatch({type:"SET_VIEW",view:"status",course:c.id})} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:"status",course:c.id})}>
              {/* The count survives into the rail — an unread-style badge is
                  the one thing on this row that still reads at 64px. The name
                  and the edit affordance do not, so they go. */}
              <div className="course-pip" style={{background:c.color}}/><span className="course-name rail-hide">{c.name}</span>
              {(open+exams)>0&&<span className="course-count">{open+exams}</span>}
              <span className="course-edit-btn rail-hide" onClick={e=>{e.stopPropagation();setEditingCourse({id:c.id,name:c.name,color:c.color});}} title={t('av.pl.edit')}>✎</span>
            </div>;
          })}
          <div className="add-course-btn" role="button" tabIndex={0} aria-label={t('av.chrome.addCourse')} title={rail?t('av.chrome.addCourse'):undefined} onClick={()=>setShowAddCourse(true)} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&setShowAddCourse(true)}><span style={{fontSize:16}}>+</span> <span className="rail-hide">{t('av.chrome.addCourse')}</span></div>
        </div>
        <div className="sidebar-foot">
          <button type="button" className="rail-toggle" onClick={toggleRail}
            aria-expanded={!rail}
            aria-label={rail?t('av.chrome.expandSidebar'):t('av.chrome.collapseSidebar')}
            title={rail?t('av.chrome.expandSidebar'):t('av.chrome.collapseSidebar')}>
            {rail
              ? <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true"/>
              : <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true"/>}
            <span className="rail-hide">{t('av.chrome.collapseSidebar')}</span>
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="main">
        <div className="topbar">
          {/* v1.9 Item 14 — the inner wrapper carries the gutter and shares
              `.content`'s max-width, so the title stays aligned with the column
              it labels instead of drifting to the window edge on wide screens. */}
          <div className="topbar-inner">
          {/* `status` has no entry in `views` (it is reached by picking a course,
              not from the nav), so it fell through to `undefined` here — the
              visible half of the dead-route bug fixed below. It names the
              course, which is what the pane is showing. */}
          <h1 className="topbar-title">{
            state.view==="actions" ? t('topbar.nextUp')
            : state.view==="status" ? (state.courses[state.activeCourse]?.name || t('nav.plan'))
            : activeView?.label
          }</h1>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {/* v1.12 Item 8e — a running block is visible from every route.
                Hidden on the timer screen itself: pointing at the page you are
                already on is the one in-app double-up worth avoiding. */}
            <TimerPill
              hidden={state.view==="timer"}
              onOpen={()=>dispatch({type:"SET_VIEW",view:"timer"})}
            />
            <div className="topbar-date">{todayStr}</div>
            {/* v1.3.1 — profile avatar opens Settings (matches NCC/LimeLog).
                Sign in / sign out now live inside Settings. Guests show "·". */}
            <button
              className={"topbar-avatar"+(state.view==="settings"?" active":"")}
              style={state.view==="settings"?undefined:accountAvatar.tintStyle}
              onClick={()=>dispatch({type:"SET_VIEW",view:"settings"})}
              title={session?.user?.email ? t('av.chrome.settingsWith', { email: session.user.email }) : t('av.chrome.settings')}
              aria-label={t('av.chrome.openSettings')}>
              <AccountAvatar avatar={accountAvatar} session={session} />
            </button>
          </div>
          </div>
        </div>
        {/* v1.9 Item 14a — `.content-wide` (added in Phase 1 as the documented
            opt-out) is claimed by the two surfaces that genuinely want the
            shell width rather than a reading measure: the calendar sheet and
            the multi-pane course detail. Everything else keeps the measure. */}
        <div className={"content"+(((state.view==="plan"&&(planSub==="calendar"||planSub==="timetable"))||state.view==="status")?" content-wide":"")}>
          {(urgent.length>0||urgentExams.length>0)&&state.view==="plan"&&(
            <div className="urgent-banner"><span>⚠️</span><div>
              <strong>{t('av.chrome.urgent')}</strong> —{" "}
              {urgentExams.map((e,i)=><span key={e.id} style={{color:"#6d3fa0"}}>{t('av.chrome.examPrefix',{title:e.title})}{i<urgentExams.length-1?", ":""}</span>)}
              {urgent.length>0&&urgentExams.length>0&&", "}
              {urgent.map((a,i)=><span key={a.id}>{a.title}{i<urgent.length-1?", ":""}</span>)}
            </div></div>
          )}
          {/* v1.3 — keyed wrapper triggers the page-turn cross-fade on view switch.
              The urgent banner above stays sticky (lives outside the wrapper), so
              only the routed view animates. */}
          <div className="page-turn" key={state.view}>
          {state.view==="plan"   &&(
            <>
              <div className="timer-subtabs" role="tablist" aria-label={t('cal.viewMode')}>
                {/* Timetable is a third sub-tab rather than a fifth bottom tab,
                    for the reason the calendar was: Item 6 sized that bar
                    against the longest label the app ships, and the recurring
                    skeleton of the week belongs beside the plan it shapes. */}
                {[["list","cal.planList"],["calendar","cal.planCalendar"],["timetable","tt.tab"]].map(([id,key])=>(
                  <button key={id} type="button" role="tab" aria-selected={planSub===id}
                    className={"timer-subtab"+(planSub===id?" active":"")}
                    onClick={()=>choosePlanSub(id)}>{t(key)}</button>
                ))}
              </div>
              <div className="page-turn" key={planSub}>
                {planSub==="calendar" &&
                  <CalendarView state={state} dispatch={dispatch} session={session} showFlash={showFlash} tier={shellTier} onAddAsgn={()=>setShowAddAsgn(true)} onAddExam={()=>setShowAddExam(true)}/>}
                {planSub==="timetable" &&
                  <TimetableView state={state} dispatch={dispatch} session={session} showFlash={showFlash}/>}
                {planSub==="list" &&
                  <PlanView state={state} dispatch={dispatch} session={session} showFlash={showFlash} onAddAsgn={()=>setShowAddAsgn(true)} onAddExam={()=>setShowAddExam(true)} onAddCourse={()=>setShowAddCourse(true)} onEditCourse={(c)=>setEditingCourse(c)}/>}
              </div>
            </>
          )}
          {/* v1.9 Item 14a — `status` was a DEAD ROUTE: clicking a course in the
              desktop sidebar has always dispatched view:"status", and nothing
              rendered it, so the content area went blank and the topbar title
              read `undefined`. StatusView existed but was never mounted. It is
              the course-detail pane of the three-pane layout, so it lands here
              rather than being patched out of the sidebar. */}
          {state.view==="status" &&<CourseDetailView state={state} dispatch={dispatch} session={session} showFlash={showFlash} tier={shellTier} onAddAsgn={()=>setShowAddAsgn(true)} onAddExam={()=>setShowAddExam(true)} onEditCourse={(c)=>setEditingCourse(c)}/>}
          {state.view==="actions" &&<ActionsView state={state} dispatch={dispatch} showFlash={showFlash} onAddCourse={()=>setShowAddCourse(true)}/>}
          {/* v1.9 Item 14a — Grades gains a Trends sub-tab. The analytics read
              grades AND study sessions together, and "how am I doing" is the
              question this screen already answers, so it belongs here rather
              than as a sixth destination in a four-tab bar. */}
          {state.view==="grades"  &&(
            <>
              <div className="timer-subtabs" role="tablist" aria-label={t('nav.grades')}>
                {[["grades","nav.grades"],["trends","an.trends"]].map(([id,key])=>(
                  <button key={id} type="button" role="tab" aria-selected={gradesSub===id}
                    className={"timer-subtab"+(gradesSub===id?" active":"")}
                    onClick={()=>setGradesSub(id)}>{t(key)}</button>
                ))}
              </div>
              <div className="page-turn" key={gradesSub}>
                {gradesSub==="trends"
                  ? <AnalyticsView state={state}/>
                  : <GradesView state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
              </div>
            </>
          )}
          {state.view==="timer"   &&(
            <>
              <div className="timer-subtabs" role="tablist" aria-label="Timer sections">
                {[["timer","av.tm.timerTab"],["log","av.tm.logTab"],["stats","av.tm.statsTab"]].map(([id,key])=>(
                  <button key={id} type="button" role="tab" aria-selected={timerSub===id}
                    className={"timer-subtab"+(timerSub===id?" active":"")}
                    onClick={()=>setTimerSub(id)}>{t(key)}</button>
                ))}
              </div>
              <div className="page-turn" key={timerSub}>
                {timerSub==="timer" &&<TimerView   state={state} dispatch={dispatch} session={session} showFlash={showFlash} onTimerComplete={(payload)=>setPendingSession(payload)}/>}
                {timerSub==="log"   &&<SessionsView state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
                {timerSub==="stats" &&<StatsView    state={state}/>}
              </div>
            </>
          )}
          {state.view==="settings"&&<SettingsView state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
          </div>
        </div>
      </main>

      {/* ── Mobile: collapsible course strip + bottom tab bar ── */}
      <nav className="mobile-tabbar">
        {views.map(v=><div key={v.id} role="button" tabIndex={0} className={"mobile-tab"+(state.view===v.id?" active":"")}
          onClick={()=>dispatch({type:"SET_VIEW",view:v.id})}
          onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:v.id})}>
          <v.Icon size={20} strokeWidth={1.75} aria-hidden="true"/>
          <span className="mobile-tab-label">{v.label}</span>
        </div>)}
      </nav>
      </div>
    )}

    {/* ── Modals ── */}
    {showAddCourse&&<div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t('av.md.addCourse')} onClick={()=>setShowAddCourse(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-title">{t('av.md.addCourse')}</div>
      <div className="input-group"><div className="input-label">{t('course.name')}</div><input type="text" placeholder={t('course.namePlaceholder')} value={newCourseName} onChange={e=>setNewCourseName(e.target.value)} {...enterSubmit(addCourse)} autoFocus/></div>
      <div style={{marginBottom:16}}><CoursePicker value={newCourseColor} onChange={setNewCourseColor}/></div>
      <div style={{display:"flex",gap:8}}><button className="btn" onClick={addCourse}>{t('av.chrome.addCourse')}</button><button className="btn-outline" onClick={()=>setShowAddCourse(false)}>{t('common.cancel')}</button></div>
    </div></div>}
    {showAddAsgn&&<AddAsgnModal courses={courses} activeCourse={state.activeCourse} onAdd={(data)=>{dispatch({type:"ADD_ASSIGNMENT",title:data.title,courseId:data.courseId,assignType:data.type,dueDate:data.dueDate,notes:data.notes});setShowAddAsgn(false);showFlash(t('av.flash.assignmentAdded'));}} onClose={()=>setShowAddAsgn(false)}/>}
    {showAddExam&&<AddExamModal courses={courses} activeCourse={state.activeCourse} onAdd={(data)=>{dispatch({type:"ADD_EXAM",...data});setShowAddExam(false);showFlash(t('av.flash.examAdded'));}} onClose={()=>setShowAddExam(false)}/>}
    {editingCourse&&<EditCourseModal
      course={state.courses[editingCourse.id] || editingCourse}
      courses={state.courses}
      onSave={(name,color,credits,semester,schoolYear)=>{
        dispatch({type:"EDIT_COURSE",id:editingCourse.id,name,color,credits,semester,schoolYear});
        setEditingCourse(null); showFlash(t('av.flash.courseUpdated'));
        if (session) outbox.enqueue("upsert_subject", { id:editingCourse.id, name, credits, semester, schoolYear, color });
      }}
      onDelete={()=>{
        const id=editingCourse.id;
        dispatch({type:"DELETE_COURSE",id});
        setEditingCourse(null); showFlash(t('av.flash.courseDeleted'));
        if (session) outbox.enqueue("delete_subject", { id });
      }}
      onClose={()=>setEditingCourse(null)}/>}
    {pendingSession && (
      <SaveSessionSheet
        pending={pendingSession}
        courses={courses}
        canDebrief={!!session && state.aiEnabled}
        onClose={()=>setPendingSession(null)}
        onSave={async ({subjectId, durationMinutes, notes, startedAt, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary}) => {
          const id = newSyncId();
          dispatch({type:"ADD_SESSION", id, subjectId: subjectId||null, startedAt, durationMinutes, notes, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary});
          setPendingSession(null);
          showFlash(t('av.flash.logged', { n: durationMinutes }));
          if (session) outbox.enqueue("log_session", { id, subjectId, startedAt, durationMinutes, notes, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary });
        }}
      />
    )}
    {flash&&<div className="flash">{flash}</div>}
    {/* Item 8 — asks once per account, only inside the account-age window,
        and only once onboarding is out of the way. Guests have no auth
        metadata to write to, so `session?.user` is the whole gate. */}
    {onboarded && session?.user && <ReferralPrompt user={session.user}/>}
  </>);
}

// ── OnboardingView — 4-step first-run wizard (cream-paper design) ─────────────
// Steps: 0 language · 1 welcome · 2 first course · 3 daily reminders.
// Shared chrome — wordmark, tagline, progress ticks — wraps every step's body.
//
// Module scope, not nested inside OnboardingView. Declared in the render body it
// was a fresh component type every render, so React unmounted and remounted the
// whole subtree on each keystroke in the step-2 course-name field. Measured
// before and after: pre-fix the <input> DOM node was replaced on every character
// typed; now it survives. autoFocus re-fired on each remount so focus was never
// visibly lost, which is why this went unnoticed — but replacing the focused
// input mid-edit is the kind of churn that upsets IME composition, and zh / hi /
// ar users compose every character.
function OnboardingShell({ step, tagline, children }) {
  return (
    <div className="ob-wrap">
      <div className="ob-card">
        <div className="ob-pad">
          <div className="ob-wordmark">StudyDesk</div>
          <div className="ob-tagline">{tagline}</div>
          <div className="ob-steps">
            {[0,1,2,3].map(i => (
              <div key={i} className={"ob-step-dot"+(i===step?" active":i<step?" done":"")}/>
            ))}
          </div>
          <div className="ob-step-body" key={step}>{children}</div>
        </div>
      </div>
    </div>
  );
}

function OnboardingView({ onComplete }) {
  const { t, i18n } = useTranslation();
  const currentLang = (i18n.language || "en").split("-")[0];
  const langRef = useScrollSelectedIntoView();
  const [step, setStep] = useState(0);
  const [courseName, setCourseName] = useState("");
  const [courseColor, setCourseColor] = useState(COURSE_COLORS[0]);

  const chosenColor = courseColor;
  const result = () => courseName.trim() ? { name: courseName.trim(), color: chosenColor } : null;


  if (step === 0) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-step-title">{t('sdob.langTitle')}</div>
      <div className="ob-step-desc">{t('sdob.langBody')}</div>
      <div className="ob-langs" ref={langRef}>
        {SUPPORTED_LANGS.map((code)=>(
          <button key={code} className={"ob-lang"+(currentLang===code?" on":"")}
            onClick={()=>setLanguage(code)} aria-pressed={currentLang===code}>
            {LANGUAGE_NAMES[code]}
          </button>
        ))}
      </div>
      <button className="btn" style={{width:"100%",padding:"13px",marginTop:16}} onClick={()=>setStep(1)}>
        {t('sdob.continue')} <span className="rtl-mirror" aria-hidden>→</span>
      </button>
    </OnboardingShell>
  );

  if (step === 1) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-step-title">{t('sdob.welcomeTitle')}</div>
      <div className="ob-step-desc">{t('sdob.welcomeBody')}</div>
      <button className="btn" style={{width:"100%",padding:"13px"}} onClick={()=>setStep(2)}>
        {t('sdob.getStarted')} <span className="rtl-mirror" aria-hidden>→</span>
      </button>
    </OnboardingShell>
  );

  if (step === 2) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-step-title">{t('sdob.courseTitle')}</div>
      <div className="ob-step-desc">{t('sdob.courseBody')}</div>
      <div className="input-group">
        <div className="input-label">{t('sdob.courseNameLabel')}</div>
        <input type="text" placeholder={t('sdob.coursePlaceholder')}
          value={courseName} onChange={e=>setCourseName(e.target.value)}
          {...enterSubmit(()=>courseName.trim()&&setStep(3))}
          autoFocus/>
      </div>
      <div className="input-group">
        <div className="input-label">{t('sdob.colorLabel')}</div>
        <CoursePicker value={courseColor} onChange={setCourseColor}/>
      </div>
      <button className="btn" style={{width:"100%",padding:"13px",marginTop:8}}
        onClick={()=>{ if(courseName.trim()) setStep(3); }}>
        {t('sdob.continue')} <span className="rtl-mirror" aria-hidden>→</span>
      </button>
      <div className="ob-skip" onClick={()=>setStep(3)}>{t('sdob.skip')}</div>
    </OnboardingShell>
  );

  if (step === 3) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-notif-box">
        <div className="ob-notif-icon">🔔</div>
        <div className="ob-notif-title">{t('sdob.notifTitle')}</div>
        <div className="ob-notif-desc">{t('sdob.notifBody')}</div>
      </div>
      {/* These two buttons were wired to the identical handler, so "Maybe
          later" completed onboarding exactly like "Enable reminders" and the
          OS permission prompt fired either way. The choice now travels with
          the completion. */}
      <button className="btn" style={{width:"100%",padding:"13px",marginBottom:10}} onClick={()=>onComplete(result(), { notifications: true })}>
        {t('sdob.enableReminders')}
      </button>
      <button className="btn-outline" style={{width:"100%",padding:"11px"}} onClick={()=>onComplete(result(), { notifications: false })}>
        {t('sdob.maybeLater')}
      </button>
    </OnboardingShell>
  );

  return null;
}

// ── CourseDetailView — the middle pane of the desktop three-pane layout ──────
//
// v1.9 Item 14a. Replaces `StatusView`, which was written for the `status`
// route and then never mounted — clicking a course in the sidebar dispatched
// `view:"status"` and rendered nothing at all. Rather than restore a component
// that only listed assignments, this is the course-detail pane the build plan
// asks for: the sidebar is the list, this is the detail, and on the desktop
// tier a third column carries what is coming up and what has been put in.
function CourseDetailView({ state, dispatch, session, showFlash, tier, onAddAsgn, onAddExam, onEditCourse }) {
  const { t } = useTranslation();
  const ac = state.activeCourse;
  const course = ac ? state.courses[ac] : null;

  if (!course || course.deletedAt) {
    return <div className="empty">{t('cal.courseGone')}</div>;
  }

  const assignments = state.assignments.filter(a => a.courseId === ac);
  const open = assignments.filter(a => !a.done)
    .sort((a, b) => new Date(a.dueDate || "9999-12-31") - new Date(b.dueDate || "9999-12-31"));
  const done = assignments.filter(a => a.done)
    .sort((a, b) => new Date(b.dueDate || "1970-01-01") - new Date(a.dueDate || "1970-01-01"));
  const exams = state.exams.filter(e => e.courseId === ac);
  const openExams = exams.filter(e => !e.done).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const sessions = (state.studySessions || []).filter(s => !s.deletedAt && s.subjectId === ac);
  const totalMin = sessions.reduce((n, s) => n + (s.durationMinutes || 0), 0);

  // Weighted mean of this course's own grades. No scale conversion: every
  // grade within one course shares the same scale, so the raw weighted mean is
  // the honest number here — converting would need the GPA machinery and would
  // say something different from what the Grades screen already shows.
  const grades = (state.grades || []).filter(g => !g.deletedAt && g.subjectId === ac);
  const wSum = grades.reduce((n, g) => n + (Number(g.weight) || 0), 0);
  const mean = wSum > 0
    ? grades.reduce((n, g) => n + Number(g.grade) * (Number(g.weight) || 0), 0) / wSum
    : null;

  const stats = [
    { label: t('cal.statOpen'), value: open.length },
    { label: t('cal.statExams'), value: openExams.length },
    { label: t('cal.statStudied'), value: totalMin >= 60 ? `${Math.round(totalMin / 60)}h` : `${totalMin}m` },
    { label: t('cal.statAverage'), value: mean === null ? '—' : mean.toFixed(2) },
  ];

  const body = (
    <div>
      <div className="cdv-head" style={{ borderInlineStartColor: course.color }}>
        <div className="cdv-head-main">
          <div className="cdv-name">{course.name}</div>
          <div className="cdv-sub">
            {course.semester && <span>{course.semester}</span>}
            {course.schoolYear && <span>· {course.schoolYear}</span>}
            {course.credits != null && <span>· {t('cal.credits', { n: course.credits })}</span>}
            {course.archivedAt && <span>· {t('cal.archived')}</span>}
          </div>
        </div>
        <button className="btn-outline btn-sm" onClick={() => onEditCourse({ id: course.id, name: course.name, color: course.color })}>
          {t('av.pl.edit')}
        </button>
      </div>

      <div className="cdv-stats">
        {stats.map(s => (
          <div key={s.label} className="cdv-stat">
            <div className="cdv-stat-value">{s.value}</div>
            <div className="cdv-stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="section-label">
        {t('av.pl.assignments')}
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onAddAsgn}>{t('av.pl.add')}</button>
      </div>
      {open.length === 0 && <div className="empty">{t('av.pl.noOpenAsgn')}</div>}
      {open.map(a => <AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash} />)}
      {done.length > 0 && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", cursor: "pointer", padding: "8px 0" }}>
            {t('av.pl.completed', { count: done.length })}
          </summary>
          {done.map(a => <AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash} />)}
        </details>
      )}

      <div className="divider" />
      <div className="section-label">
        {t('av.pl.examsCalendar')}
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onAddExam}>{t('av.pl.add')}</button>
      </div>
      {openExams.length === 0 && <div className="empty">{t('av.pl.noExams')}</div>}
      {openExams.map(e => <ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch} />)}
    </div>
  );

  if (tier !== 'desktop') return body;

  // Third pane. Recent sessions only — the full history has its own screen,
  // and a course pane that grows without bound stops being a summary.
  const recent = sessions
    .slice()
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 8);

  return (
    <div className="cdv-split">
      {body}
      <aside className="cdv-aside">
        <div className="cdv-aside-label">{t('cal.recentSessions')}</div>
        {recent.length === 0 && <div className="cdv-aside-empty">{t('cal.noSessionsYet')}</div>}
        {recent.map(s => (
          <div key={s.id} className="cdv-session">
            <div className="cdv-session-when">{fmtDateFull(toLocalISO(new Date(s.startedAt)))}</div>
            <div className="cdv-session-len">
              {s.durationMinutes >= 60
                ? `${Math.floor(s.durationMinutes / 60)}h ${s.durationMinutes % 60 || ''}${s.durationMinutes % 60 ? 'm' : ''}`.trim()
                : `${s.durationMinutes}m`}
              {s.focusRating != null && <span className="cdv-session-focus"> · {t('cal.focus', { n: s.focusRating })}</span>}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}

function AsgnItem({ asgn, courses, dispatch, attachments = [], session, showFlash }) {
  const { t } = useTranslation();
  const course=courses[asgn.courseId]; const days=daysUntil(asgn.dueDate);
  const [editing,setEditing]=useState(false);
  // v1.10 — the row itself is the drop target, which is what "drag-drop file
  // attachment on assignments" actually means: drag the essay onto the essay.
  const [showAt,setShowAt]=useState(false);
  const drop=useAttachmentDrop({assignmentId:asgn.id,dispatch,session,showFlash});
  const mine=attachments.filter(a=>a.assignmentId===asgn.id&&!a.deletedAt);
  const [editTitle,setEditTitle]=useState(asgn.title);
  const [editDate,setEditDate]=useState(asgn.dueDate||"");
  const [editNotes,setEditNotes]=useState(asgn.notes||"");
  const save=()=>{ dispatch({type:"EDIT_ASSIGNMENT",id:asgn.id,title:editTitle.trim()||asgn.title,dueDate:editDate,notes:editNotes}); setEditing(false); };
  if(editing) return <div className="asgn-item" style={{flexDirection:"column",gap:10}}>
    <input type="text" value={editTitle} onChange={e=>setEditTitle(e.target.value)} style={{fontWeight:500}} autoFocus/>
    <input type="date" value={editDate} onChange={e=>setEditDate(e.target.value)}/>
    <textarea value={editNotes} onChange={e=>setEditNotes(e.target.value)} placeholder={t('sv.fNotes')+"…"} style={{minHeight:48,fontSize:12}}/>
    <div style={{display:"flex",gap:8}}><button className="btn btn-sm" onClick={save}>{t('common.save')}</button><button className="btn-outline btn-sm" onClick={()=>setEditing(false)}>{t('common.cancel')}</button></div>
  </div>;
  return <div
    className={"asgn-item"+(asgn.done?" done":"")+(drop.isOver?" drop-over":"")+(showAt?" has-panel":"")}
    {...drop.dropProps}
    onDrop={(e)=>{ drop.dropProps.onDrop(e); setShowAt(true); }}
  >
    <div className={"asgn-check"+(asgn.done?" checked":"")} onClick={()=>dispatch({type:"TOGGLE_ASSIGNMENT",id:asgn.id})}/>
    <div className="asgn-body">
      <div className={"asgn-title"+(asgn.done?" done":"")}>{asgn.title}</div>
      <div className="asgn-meta">
        {course&&<span className="asgn-course" style={{background:course.color+"18",color:course.color}}>{course.name}</span>}
        {asgn.type&&<span className="asgn-type">{t(`av.assignType.${asgn.type}`,{defaultValue:asgn.type})}</span>}
        {asgn.dueDate&&<span className="asgn-due" style={{color:asgn.done?"var(--muted2)":urgencyColor(days)}}>{fmtDate(asgn.dueDate,t)} · {urgencyLabel(days,t)}</span>}
      </div>
      {asgn.notes&&<div className="asgn-notes">{asgn.notes}</div>}
    </div>
    <button
      className={"asgn-clip"+(mine.length?" has":"")}
      onClick={()=>setShowAt(v=>!v)}
      aria-expanded={showAt}
      title={mine.length?t('at.countTitle',{n:mine.length}):t('at.title')}
    >
      <Paperclip size={13} strokeWidth={1.75}/>
      {mine.length>0&&<span className="asgn-clip-n">{mine.length}</span>}
    </button>
    <button className="btn-danger-text" style={{fontSize:13,color:"var(--muted2)"}} onClick={()=>setEditing(true)} title={t('av.pl.edit')}>✎</button>
    <button className="btn-danger-text" onClick={()=>dispatch({type:"DELETE_ASSIGNMENT",id:asgn.id})}>×</button>
    {showAt&&<AttachmentList
      attachments={mine}
      dispatch={dispatch}
      session={session}
      showFlash={showFlash}
      uploadFiles={drop.uploadFiles}
      busy={drop.busy}
    />}
  </div>;
}

function PlanView({ state, dispatch, session, showFlash, onAddAsgn, onAddExam, onAddCourse, onEditCourse }) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || "en").split("-")[0];
  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
  const [calMonth, setCalMonth] = useState(()=>{const d=new Date(); return {year:d.getFullYear(),month:d.getMonth()};});
  const [expandedCourse, setExpandedCourse] = useState({});
  const firstDay = new Date(calMonth.year,calMonth.month,1);
  const lastDay  = new Date(calMonth.year,calMonth.month+1,0);
  const startPad = firstDay.getDay();
  const days = [];
  for(let i=0;i<startPad;i++){const d=new Date(calMonth.year,calMonth.month,-(startPad-1-i));days.push({date:d,current:false});}
  for(let i=1;i<=lastDay.getDate();i++) days.push({date:new Date(calMonth.year,calMonth.month,i),current:true});
  while(days.length%7!==0){const d=new Date(calMonth.year,calMonth.month+1,days.length-lastDay.getDate()-startPad+1);days.push({date:d,current:false});}
  const eventsOnDay=(date)=>{
    const ds=toLocalISO(date);
    const examEvents=state.exams.filter(e=>e.dueDate===ds).map(e=>({type:"exam",exam:e,course:state.courses[e.courseId]}));
    const studyEvents=state.exams.filter(e=>!e.done&&studyStartDate(e)===ds).map(e=>({type:"study",exam:e,course:state.courses[e.courseId]}));
    const asgnEvents=state.assignments.filter(a=>!a.done&&a.dueDate===ds).map(a=>({type:"assignment",asgn:a,course:state.courses[a.courseId]}));
    return [...examEvents,...studyEvents,...asgnEvents];
  };
  const dayIsToday=(date)=>toLocalISO(date)===toLocalISO(todayMidnight());
  const monthName=firstDay.toLocaleDateString(lang||"en",{month:"long",year:"numeric"});
  const prevMonth=()=>setCalMonth(m=>m.month===0?{year:m.year-1,month:11}:{year:m.year,month:m.month-1});
  const nextMonth=()=>setCalMonth(m=>m.month===11?{year:m.year+1,month:0}:{year:m.year,month:m.month+1});
  const agendaEvents=[];
  const _agendaBase=todayMidnight();
  for(let i=0;i<60;i++){const d=new Date(_agendaBase);d.setDate(_agendaBase.getDate()+i);const ev=eventsOnDay(d);if(ev.length>0)agendaEvents.push({date:d,events:ev});}
  const openAsgns=state.assignments.filter(a=>!a.done).sort((a,b)=>new Date(a.dueDate||"9999-12-31")-new Date(b.dueDate||"9999-12-31"));
  const openExams=state.exams.filter(e=>!e.done).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
  // The root is NOT a tiling grid: this view also holds the month grid, the
  // agenda and the course cards, and tiling those would break each of them.
  // Only the flat lists tile, which is where the vertical length comes from.
  return <div className="sd-page-plan">
    <div className="section-label">{t('av.pl.assignments')}<button className="btn btn-sm" onClick={onAddAsgn}>{t('av.pl.add')}</button></div>
    {openAsgns.length===0&&<div className="empty">{t('av.pl.noOpenAsgn')}</div>}
    <div className="sd-list-tile">{openAsgns.map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash}/>)}</div>
    {state.assignments.filter(a=>a.done).length>0&&<details style={{marginBottom:16}}><summary style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",cursor:"pointer",padding:"8px 0"}}>{t('av.pl.completed',{count:state.assignments.filter(a=>a.done).length})}</summary>{state.assignments.filter(a=>a.done).sort((a,b)=>new Date(b.dueDate||"1970-01-01")-new Date(a.dueDate||"1970-01-01")).map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash}/>)}</details>}
    <div className="divider"/>
    <div className="section-label">{t('av.pl.examsCalendar')}<button className="btn btn-sm" onClick={onAddExam}>{t('av.pl.add')}</button></div>
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
      <button className="btn-outline btn-sm" onClick={prevMonth}><span className="rtl-mirror" aria-hidden>←</span></button>
      <span style={{fontFamily:"var(--font-display)",fontSize:16,flex:1}}>{monthName}</span>
      <button className="btn-outline btn-sm" onClick={nextMonth}><span className="rtl-mirror" aria-hidden>→</span></button>
    </div>
    <div className="calendar-grid cal-header-row" style={{marginBottom:0,gap:4}}>{["sun","mon","tue","wed","thu","fri","sat"].map(d=><div key={d} className="cal-header">{t(`av.cal.${d}`)}</div>)}</div>
    <div className="calendar-grid" style={{marginBottom:16}}>
      {days.map((day,i)=>{const events=eventsOnDay(day.date);return <div key={i} className={"cal-day"+(dayIsToday(day.date)?" today":"")+(day.current?"":" other-month")}><div className="cal-day-num">{day.date.getDate()}</div>{events.map((ev,j)=>{if(ev.type==="exam") return <div key={j} className="cal-event cal-exam" title={t('av.chrome.examPrefix',{title:ev.exam.title})}>📝 {ev.exam.title}</div>;if(ev.type==="study") return <div key={j} className="cal-event cal-study" title={t('av.ec.studyStart')+" "+ev.exam.title}>📚 {ev.exam.title}</div>;const col=ev.course?.color||"#8a8278";return <div key={j} className="cal-event" style={{background:col+"22",color:col}} title={ev.asgn.title}>◷ {ev.asgn.title}</div>;})}</div>;})}
    </div>
    <div className="cal-agenda" style={{marginBottom:16}}>
      {agendaEvents.length===0&&<div className="empty">{t('av.pl.nothingComingUp')}</div>}
      {agendaEvents.map((entry,i)=>{const label=entry.date.toLocaleDateString(lang||"en",{weekday:"short",day:"numeric",month:"short"});return <div key={i} className="cal-agenda-item"><div className="cal-agenda-date">{label}</div><div className="cal-agenda-pills">{entry.events.map((ev,j)=>{if(ev.type==="exam"||ev.type==="study"){const c=ev.course;return <div key={j} className="cal-agenda-pill" style={{background:ev.type==="exam"?"rgba(109,63,160,0.10)":"rgba(26,92,158,0.08)"}}><span>{ev.type==="exam"?"📝":"📚"}</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,color:ev.type==="exam"?"#6d3fa0":"#1a5c9e"}}>{ev.type==="exam"?t('av.pl.examWord'):t('av.pl.studyWord')}</span><span style={{fontSize:13}}>{ev.exam.title}</span>{c&&<span className="asgn-course" style={{background:c.color+"18",color:c.color}}>{c.name}</span>}</div>;}const c=ev.course;return <div key={j} className="cal-agenda-pill" style={{background:c?c.color+"18":"var(--surface2)"}}><span>◷</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,color:c?.color||"var(--muted)"}}>{t('av.pl.dueWord')}</span><span style={{fontSize:13}}>{ev.asgn.title}</span>{c&&<span className="asgn-course" style={{background:c.color+"18",color:c.color}}>{c.name}</span>}</div>;})}</div></div>;})}
    </div>
    {openExams.map(e=><ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch}/>)}
    {openExams.length===0&&<div className="empty">{t('av.pl.noExams')}</div>}
    {state.exams.filter(e=>e.done).length>0&&<details style={{marginBottom:16}}><summary style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",cursor:"pointer",padding:"8px 0"}}>{t('av.pl.completedExams',{count:state.exams.filter(e=>e.done).length})}</summary>{state.exams.filter(e=>e.done).map(e=><ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch}/>)}</details>}
    <div className="divider"/>
    <div className="section-label">{t('av.pl.courses')}<button className="btn btn-sm" onClick={onAddCourse}>{t('av.pl.add')}</button></div>
    {courses.length===0&&<div className="empty">{t('av.pl.noCourses')}</div>}
    <div className="home-grid">
      {courses.map(c=>{const openA=state.assignments.filter(a=>a.courseId===c.id&&!a.done);const openE=state.exams.filter(e=>e.courseId===c.id&&!e.done);const isOpen=!!expandedCourse[c.id];const nextA=openA.filter(a=>a.dueDate).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];const nextE=[...openE].sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];const hasUrgent=openA.some(a=>{const d=daysUntil(a.dueDate);return d!==null&&d<=2;})||openE.some(e=>{const d=daysUntil(e.dueDate);return d!==null&&d<=5;});return <div key={c.id} className="course-card" style={{borderInlineStartColor:c.color}}><div role="button" tabIndex={0} className="course-card-compact" onClick={()=>setExpandedCourse(x=>({...x,[c.id]:!x[c.id]}))} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&setExpandedCourse(x=>({...x,[c.id]:!x[c.id]}))}><div className="course-card-left"><div className="course-card-name">{c.name}</div><div className="course-card-pills">{openA.length>0&&<span className={"course-card-pill"+(hasUrgent?" urgent":"")}>{t('av.pl.due',{count:openA.length})}</span>}{openE.length>0&&<span className="course-card-pill" style={{background:"rgba(109,63,160,0.08)",color:"#6d3fa0",borderColor:"rgba(109,63,160,0.18)"}}>{t('av.pl.exam',{count:openE.length})}</span>}{openA.length===0&&openE.length===0&&<span className="course-card-pill" style={{color:"#2e7d52",borderColor:"rgba(46,125,82,0.2)"}}>{t('av.pl.clear')}</span>}</div></div><span className={"course-card-chevron"+(isOpen?" open":"")}>▶</span></div>{isOpen&&<div className="course-card-detail"><div className="course-card-next">{nextE&&<div style={{color:"#6d3fa0",marginBottom:5,fontFamily:"var(--font-mono)",fontSize:11}}>📝 <strong>{nextE.title}</strong> — {urgencyLabel(daysUntil(nextE.dueDate),t)}</div>}{nextA&&<div style={{marginBottom:5}}>{t('av.pl.next')} <strong>{nextA.title}</strong><span style={{color:urgencyColor(daysUntil(nextA.dueDate)),marginLeft:6,fontFamily:"var(--font-mono)",fontSize:11}}>{urgencyLabel(daysUntil(nextA.dueDate),t)}</span></div>}{!nextA&&!nextE&&<span style={{color:"var(--muted2)",fontFamily:"var(--font-mono)",fontSize:11}}>{t('av.pl.nothingDue')}</span>}</div><div className="course-card-actions"><button className="btn-outline btn-sm" onClick={()=>onEditCourse({id:c.id,name:c.name,color:c.color})}>{t('av.pl.edit')}</button></div></div>}</div>;})}
    </div>
  </div>;
}

// ── ExamCard ──────────────────────────────────────────────────────────────────
function ExamCard({ exam, courses, dispatch }) {
  const { t } = useTranslation();
  const [topicInput, setTopicInput] = useState("");
  const [open, setOpen] = useState(false);
  const course=courses[exam.courseId]; const days=daysUntil(exam.dueDate);
  const studyStart=studyStartDate(exam); const studyDays=daysUntil(studyStart);
  const diff=exam.difficulty||"medium"; const topics=exam.topics||[];
  const doneCnt=topics.filter(t=>t.done).length;
  const pct=topics.length>0?Math.round((doneCnt/topics.length)*100):0;
  const progressColor=pct===100?"#2e7d52":pct>50?"#d4860a":"#c0392b";
  const addTopic=()=>{ if(!topicInput.trim()) return; dispatch({type:"ADD_EXAM_TOPIC",examId:exam.id,title:topicInput.trim()}); setTopicInput(""); };
  return <div className={"exam-card"+(exam.done?" done":"")} style={{borderInlineStartColor:course?.color||"var(--border2)"}}>
    <div className="exam-card-header" onClick={()=>setOpen(o=>!o)}>
      <div className={"asgn-check"+(exam.done?" checked":"")} style={{marginTop:5,flexShrink:0}} onClick={e=>{e.stopPropagation();dispatch({type:"TOGGLE_EXAM",id:exam.id});}}/>
      <div className="exam-card-header-info">
        <div className={"exam-card-title"+(exam.done?" done":"")}>{exam.title}</div>
        <div className="exam-card-meta">
          {course&&<span className="asgn-course" style={{background:course.color+"18",color:course.color}}>{course.name}</span>}
          <span className="tag tag-exam">{t('av.ec.examTag')}</span>
          {exam.dueDate&&<span style={{fontFamily:"var(--font-mono)",fontSize:11,fontWeight:500,color:exam.done?"var(--muted2)":urgencyColor(days)}}>{fmtDate(exam.dueDate,t)} · {urgencyLabel(days,t)}</span>}
        </div>
        {topics.length>0&&<div className="exam-header-progress"><div className="exam-header-progress-track"><div className="exam-header-progress-fill" style={{width:pct+"%",background:progressColor}}/></div><span className="exam-header-progress-txt">{t('av.ec.topicsCount',{done:doneCnt,total:topics.length})}{pct===100?" ✓":""}</span></div>}
      </div>
      <span style={{fontSize:10,color:"var(--muted2)",transform:open?"rotate(90deg)":"rotate(0deg)",transition:"transform 0.2s",flexShrink:0,marginLeft:6}}>▶</span>
      <button className="btn-danger-text" style={{flexShrink:0}} onClick={e=>{e.stopPropagation();dispatch({type:"DELETE_EXAM",id:exam.id});}}>×</button>
    </div>
    {open&&<div className="exam-card-body">
      {exam.notes&&<div className="exam-card-notes">{exam.notes}</div>}
      {!exam.done&&<div className="study-plan-bar">
        <span className="study-plan-label">{t('av.ec.difficulty')}</span>
        {["easy","medium","hard","brutal"].map(d=><span key={d} className="difficulty-pill" style={{background:diff===d?DIFFICULTY_COLORS[d]+"18":"transparent",color:diff===d?DIFFICULTY_COLORS[d]:"var(--muted2)",borderColor:diff===d?DIFFICULTY_COLORS[d]:"var(--border2)"}} onClick={()=>dispatch({type:"UPDATE_EXAM_DIFFICULTY",id:exam.id,difficulty:d})}>{t(`av.difficulty.${d}`)}</span>)}
      </div>}
      {!exam.done&&exam.dueDate&&<div className="study-plan-bar"><span className="study-plan-label">{t('av.ec.startStudying')}</span><span className="study-plan-date">{fmtDateFull(studyStart)}</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,color:studyDays<=0?"#c0392b":studyDays<=3?"#d4860a":"var(--muted)"}}>({studyDays<=0?t('av.ec.now'):t('av.ec.inDays',{n:studyDays})})</span></div>}
      <div className="topics-section">
        <div className="topics-section-header">
          <span className="topics-section-label">{t('av.ec.topics')}</span>
          {topics.length>0&&<><div className="topics-big-progress-wrap"><div className="topics-big-progress-bar" style={{width:pct+"%",background:progressColor}}/></div><span className="topics-big-progress-txt">{pct}%</span></>}
        </div>
        {topics.length===0&&<div className="topics-empty">{t('av.ec.noTopics')}</div>}
        {topics.map(tp=><div key={tp.id} className="topic-item" onClick={()=>dispatch({type:"TOGGLE_EXAM_TOPIC",examId:exam.id,topicId:tp.id})}>
          <div className={"topic-check"+(tp.done?" checked":"")}/>
          <span className={"topic-title"+(tp.done?" done":"")}>{tp.title}</span>
          <button className="topic-del" onClick={e=>{e.stopPropagation();dispatch({type:"DELETE_EXAM_TOPIC",examId:exam.id,topicId:tp.id});}}>×</button>
        </div>)}
        <div className="topic-add-row">
          <input type="text" placeholder={t('av.ec.addTopic')} value={topicInput} onChange={e=>setTopicInput(e.target.value)} {...enterSubmit(addTopic)}/>
          <button className="topic-add-btn" onClick={addTopic}>{t('av.ec.add')}</button>
        </div>
      </div>
    </div>}
  </div>;
}

// ── ActionsView — Next Up ─────────────────────────────────────────────────────
function ActionsView({ state, dispatch, showFlash, onAddCourse }) {
  const { t, i18n } = useTranslation();
  const currentLang = (i18n.language || "en").split("-")[0];
  const langRef = useScrollSelectedIntoView();
  const [newText, setNewText] = useState(""); const [newBucket, setNewBucket] = useState("today"); const [newCourse, setNewCourse] = useState("");
  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
  // v1.5 (5D) — active = non-archived. When every course is archived (a new
  // period just started) OR none exist yet (first run), Next Up has nothing to
  // build a plan from, so guide the user to add courses before deadlines.
  const activeCourses = courses.filter(c => !c.archivedAt);
  const totalDeadlines = state.assignments.filter(a=>a.dueDate&&!a.done).length + state.exams.filter(e=>e.dueDate&&!e.done).length;
  const suggestedActions = (() => {
    const actions = [];
    // Only surface assignments that are incomplete and not overdue by more than 1 day
    state.assignments.filter(a=>!a.done&&a.dueDate&&daysUntil(a.dueDate)>-1).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate)).slice(0,3).forEach(a=>{
      const d=daysUntil(a.dueDate); const c=state.courses[a.courseId];
      const bucket=d<=0?"today":d<=3?"today":d<=7?"this_week":"later";
      actions.push({id:"sugg-a-"+a.id,text:(c?c.name+": ":"")+a.title,bucket,sourceId:a.id,sourceType:"assignment",suggested:true,courseId:a.courseId||null,done:false});
    });
    // Only surface exams that are incomplete and not past their date
    state.exams.filter(e=>!e.done&&e.dueDate&&daysUntil(e.dueDate)>-1).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate)).slice(0,3).forEach(e=>{
      const d=daysUntil(e.dueDate); const c=state.courses[e.courseId];
      const incompTopics=(e.topics||[]).filter(t=>!t.done);
      const bucket=d<=3?"today":d<=7?"this_week":"later";
      const exLabel=(c?c.name+": ":"")+e.title;
      if(incompTopics.length>0){actions.push({id:"sugg-e-"+e.id,text:t('av.ec.studyFor',{label:exLabel})+" — "+incompTopics[0].title+(incompTopics.length>1?t('av.ec.topicMore',{n:incompTopics.length-1}):""),bucket,sourceId:e.id,sourceType:"exam",suggested:true,courseId:e.courseId||null,done:false});}
      else{actions.push({id:"sugg-e-"+e.id,text:t('av.ec.prepareFor',{label:exLabel}),bucket,sourceId:e.id,sourceType:"exam",suggested:true,courseId:e.courseId||null,done:false});}
    });
    return actions;
  })();
  // Auto-purge manual actions: done items cleared at 3am the following day
  const now = Date.now();
  // Item is visible if: not done, OR done but next 3am hasn't passed since it was completed
  const visibleManual = state.actions.filter(a => {
    if (!a.done) return true;
    if (!a.doneAt) return false;
    // Compute 3am of the day after doneAt
    const purgeAt = (() => {
      const d = new Date(a.doneAt); d.setHours(3, 0, 0, 0); d.setDate(d.getDate() + 1);
      return d.getTime();
    })();
    return now < purgeAt;
  });
  // Purge stale done actions from state on mount
  useEffect(() => {
    const stale = state.actions.filter(a => {
      if (!a.done || !a.doneAt) return a.done;
      const purgeAt = (() => {
        const d = new Date(a.doneAt); d.setHours(3, 0, 0, 0); d.setDate(d.getDate() + 1);
        return d.getTime();
      })();
      return now >= purgeAt;
    });
    stale.forEach(a => dispatch({type:"DELETE_ACTION", id:a.id}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const allActions = [...visibleManual, ...suggestedActions.filter(s=>!visibleManual.some(a=>a.sourceId===s.sourceId&&a.suggested))];
  const addAction = () => { if(!newText.trim()) return; dispatch({type:"ADD_ACTION",text:newText.trim(),bucket:newBucket,courseId:newCourse||null}); setNewText(""); showFlash(t('av.act.addedToNextUp')); };
  // v1.5 (5D) — empty-period / first-run re-onboarding: no active courses to plan around.
  if(activeCourses.length === 0) return <div>
    <div className="nextup-unlock">
      <div className="nextup-unlock-icon">◎</div>
      <div className="nextup-unlock-body">
        <div className="nextup-unlock-title">{t('nextup.newPeriodTitle')}</div>
        <div className="nextup-unlock-sub">{t('nextup.newPeriodSub')}</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
          <button className="btn btn-sm" onClick={()=>onAddCourse?.()}>{t('nextup.addCourse')}</button>
          <button className="btn-outline btn-sm" onClick={()=>dispatch({type:"SET_VIEW",view:"plan"})}>{t('nextup.goToPlan')}</button>
        </div>
        {/* v1.5.1 — first-run language choice. Lives in the re-onboarding
            prompt (StudyDesk's first surface) + Settings. setLanguage writes
            the localStorage override and applies live. */}
        <div style={{marginTop:18}}>
          <div style={{fontFamily:"var(--font-mono)",fontSize:10,letterSpacing:"0.18em",color:"var(--muted2)",textTransform:"uppercase",marginBottom:8}}>{t('settings.language')}</div>
          <div ref={langRef} style={{display:"flex",gap:6,flexWrap:"wrap",maxHeight:184,overflowY:"auto",overscrollBehavior:"contain"}}>
            {SUPPORTED_LANGS.map((code)=>(
              <button
                key={code}
                className={currentLang===code?"btn btn-sm":"btn-outline btn-sm"}
                onClick={()=>setLanguage(code)}
                aria-pressed={currentLang===code}
              >{LANGUAGE_NAMES[code]}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>;

  if(totalDeadlines < 1) return <div>
    <div className="nextup-unlock">
      <div className="nextup-unlock-icon">◎</div>
      <div className="nextup-unlock-body">
        <div className="nextup-unlock-title">{t('nextup.addDeadlineTitle')}</div>
        <div className="nextup-unlock-sub">{t('nextup.addDeadlineSub')}</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
          <button className="btn btn-sm" onClick={()=>dispatch({type:"SET_VIEW",view:"plan"})}>{t('nextup.goToPlan')}</button>
        </div>
      </div>
    </div>
  </div>;
  // Three buckets side by side on a wide screen rather than stacked: Today /
  // This week / Later are a natural three-column read, and stacking them is
  // what made this screen a long thin ribbon in a 1600px window.
  return <div className="sd-page-actions sd-bucket-tile">
    {BUCKETS.map(bucket=>{
      const items=allActions.filter(a=>a.bucket===bucket);
      if(items.length===0) return null;
      const col=BUCKET_COLORS[bucket];
      return <div key={bucket} className="bucket-section">
        <div className="bucket-header"><div className="bucket-dot" style={{background:col.bg}}/>{t(`av.bucket.${bucket}`)}</div>
        {items.map(a=><div key={a.id} className={"action-item"+(a.done?" done":"")+(a.suggested?" suggested":"")}>
          <div className={"asgn-check"+(a.done?" checked":"")} onClick={()=>{
            if(a.suggested){
              if(a.sourceType==="assignment") dispatch({type:"TOGGLE_ASSIGNMENT",id:a.sourceId});
              else if(a.sourceType==="exam") dispatch({type:"TOGGLE_EXAM",id:a.sourceId});
            } else {
              dispatch({type:"TOGGLE_ACTION",id:a.id});
            }
          }}/>
          <div className={"action-text"+(a.done?" done":"")}>{a.text}</div>
          {!a.suggested&&<button className="btn-danger-text" onClick={()=>dispatch({type:"DELETE_ACTION",id:a.id})}>×</button>}
          {a.suggested&&<span style={{fontFamily:"var(--font-mono)",fontSize:9,color:"#1a5c9e",letterSpacing:"0.06em",flexShrink:0}}>{t('av.act.auto')}</span>}
        </div>)}
      </div>;
    })}
    <div className="divider"/>
    <div className="section-label">{t('av.act.addManually')}</div>
    <div className="quick-add-box">
      <div className="input-row">
        <input type="text" placeholder={t('av.act.whatToDo')} value={newText} onChange={e=>setNewText(e.target.value)} {...enterSubmit(addAction)} style={{flex:2}}/>
        <select value={newBucket} onChange={e=>setNewBucket(e.target.value)} style={{flex:1,maxWidth:130}}>{BUCKETS.map(b=><option key={b} value={b}>{t(`av.bucket.${b}`)}</option>)}</select>
        <button className="btn" onClick={addAction}>{t('av.act.add')}</button>
      </div>
      {courses.length>0&&<select value={newCourse} onChange={e=>setNewCourse(e.target.value)} style={{marginTop:8,fontSize:12}}>
        <option value="">{t('av.act.noCourse')}</option>
        {courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
      </select>}
    </div>
  </div>;
}
