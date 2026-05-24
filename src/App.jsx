import { useState, useReducer, useEffect, useCallback, useRef } from "react";
import { LocalNotifications } from "@capacitor/local-notifications";
import { App as CapApp } from "@capacitor/app";
import { supabase } from "./lib/supabase.js";
import AuthGate from "./features/auth/AuthGate.jsx";
import * as sync from "./lib/sync.js";
import { applyRemotePull } from "./lib/merge.js";
import GradesView from "./features/grades/GradesView.jsx";
import SessionsView from "./features/sessions/SessionsView.jsx";
import SaveSessionSheet from "./features/sessions/SaveSessionSheet.jsx";
import SettingsView from "./features/settings/SettingsView.jsx";

const BUCKETS = ["today", "this_week", "later"];
const BUCKET_LABELS = { today: "TODAY", this_week: "THIS WEEK", later: "LATER" };
const BUCKET_COLORS = {
  today:     { bg: "#c0392b", text: "#fff" },
  this_week: { bg: "#d4860a", text: "#fff" },
  later:     { bg: "#2e7d52", text: "#fff" },
};
const ASSIGN_TYPES = ["Essay","Problem Set","Lab","Reading","Exam","Project","Quiz","Other"];
const COURSE_COLORS = ["#c0392b","#d4860a","#2e7d52","#1a5c9e","#6d3fa0","#b5470b","#1e7d7d","#8b4a62"];
const DIFFICULTY_DAYS   = { easy:3, medium:7, hard:14, brutal:21 };
const DIFFICULTY_LABELS = { easy:"Easy", medium:"Medium", hard:"Hard", brutal:"Brutal" };
const DIFFICULTY_COLORS = { easy:"#2e7d52", medium:"#d4860a", hard:"#c0392b", brutal:"#6d3fa0" };
const POMO_PRESETS = { focus:25, short:5, long:15 };

const TODAY = new Date(); TODAY.setHours(0,0,0,0);
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
// IDs that flow into Supabase MUST be proper UUIDs — the columns are typed `uuid`.
// `uid()` above produces short nanoid-style strings (~12 chars) which Postgres rejects.
// Keep `uid()` for local-only entities (assignments, exams, exam topics, actions);
// use `newSyncId()` for everything that crosses the sync boundary (subjects, grades,
// study sessions). Browser-native, no extra dep.
function newSyncId() { return crypto.randomUUID(); }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseLocalDate(s){ if(!s) return null; const[y,m,d]=s.split("-").map(Number); return new Date(y,m-1,d); }
function toLocalISO(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function daysUntil(s){ if(!s) return null; return Math.round((parseLocalDate(s)-TODAY)/86400000); }
function fmtDate(s){ if(!s) return "No date"; return parseLocalDate(s).toLocaleDateString("en-GB",{day:"numeric",month:"short"}); }
function fmtDateFull(s){ if(!s) return ""; return parseLocalDate(s).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"}); }
function urgencyColor(d){ if(d===null) return "#aaa"; if(d<0) return "#c0392b"; if(d<=2) return "#c0392b"; if(d<=7) return "#d4860a"; return "#2e7d52"; }
function urgencyLabel(d){ if(d===null) return ""; if(d<0) return Math.abs(d)+"d overdue"; if(d===0) return "Due today"; if(d===1) return "Due tomorrow"; return d+"d left"; }
function addDays(s,n){ const d=parseLocalDate(s); d.setDate(d.getDate()+n); return toLocalISO(d); }
function studyStartDate(e){ return addDays(e.dueDate,-DIFFICULTY_DAYS[e.difficulty||"medium"]); }
function fmtMMSS(sec){ return String(Math.floor(sec/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0"); }

// ── Notifications ─────────────────────────────────────────────────────────────
async function scheduleNotifications(exams, assignments, courses) {
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return;
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
          notes.push({ id: id++, title: "📚 StudyDesk — Next Up", body: topLabel, schedule: { at }, smallIcon: "ic_notification" });
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
      if (startAt.getTime() > now) notes.push({ id: id++, title: "📚 Time to start studying", body: `${label} — ${DIFFICULTY_DAYS[exam.difficulty||"medium"]}d to go`, schedule: { at: startAt }, smallIcon: "ic_notification" });
      // 2 days before at 9am
      const twoDay = parseLocalDate(addDays(exam.dueDate,-2)); twoDay.setHours(9,0,0,0);
      if (twoDay.getTime() > now) notes.push({ id: id++, title: "⚠️ Exam in 2 days", body: label, schedule: { at: twoDay }, smallIcon: "ic_notification" });
      // Exam day at 7am
      const examDay = parseLocalDate(exam.dueDate); examDay.setHours(7,0,0,0);
      if (examDay.getTime() > now) notes.push({ id: id++, title: "📝 Exam today — good luck", body: label, schedule: { at: examDay }, smallIcon: "ic_notification" });
    });

    // ── Assignment-specific notifications ──
    assignments.forEach(asgn => {
      if (asgn.done || !asgn.dueDate) return;
      const c = courses[asgn.courseId];
      const label = c ? `${asgn.title} — ${c.name}` : asgn.title;
      // Day before at 6pm
      const dayBefore = parseLocalDate(addDays(asgn.dueDate,-1)); dayBefore.setHours(18,0,0,0);
      if (dayBefore.getTime() > now) notes.push({ id: id++, title: "📋 Due tomorrow", body: label, schedule: { at: dayBefore }, smallIcon: "ic_notification" });
      // Due day at 9am
      const dueDay = parseLocalDate(asgn.dueDate); dueDay.setHours(9,0,0,0);
      if (dueDay.getTime() > now) notes.push({ id: id++, title: "📋 Due today", body: label, schedule: { at: dueDay }, smallIcon: "ic_notification" });
    });

    if (notes.length > 0) await LocalNotifications.schedule({ notifications: notes });
  } catch(e) {
    console.error("[StudyDesk] scheduleNotifications failed:", e);
  }
}



const INITIAL = {
  courses:{}, assignments:[], actions:[], exams:[],
  grades:[], studySessions:[],
  gradeMode:"ib",                  // 'ib' | 'us' — UI-only, persisted locally
  view:"actions", activeCourse:null,
};

// ── Onboarding CSS ────────────────────────────────────────────────────────────
const cssOnboard = `
.ob-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px 20px;background:var(--bg);}
.ob-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:36px 32px;width:100%;max-width:440px;box-shadow:var(--shadow-md);}
.ob-wordmark{font-family:var(--font-display);font-size:28px;font-weight:600;text-align:center;margin-bottom:6px;}
.ob-tagline{font-family:var(--font-mono);font-size:11px;color:var(--muted);text-align:center;letter-spacing:0.08em;margin-bottom:32px;}
.ob-steps{display:flex;gap:6px;justify-content:center;margin-bottom:28px;}
.ob-step-dot{width:28px;height:4px;border-radius:99px;background:var(--border);transition:background 0.2s;}
.ob-step-dot.active{background:var(--text);}
.ob-step-dot.done{background:var(--muted);}
.ob-step-title{font-family:var(--font-display);font-size:20px;margin-bottom:8px;}
.ob-step-desc{font-size:13px;color:var(--muted);margin-bottom:24px;line-height:1.6;}
.ob-colors{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px;}
.ob-color{width:26px;height:26px;border-radius:50%;cursor:pointer;transition:transform 0.1s;}
.ob-color:hover{transform:scale(1.15);}
.ob-skip{font-family:var(--font-mono);font-size:10px;color:var(--muted2);cursor:pointer;text-align:center;margin-top:16px;letter-spacing:0.05em;}
.ob-skip:hover{color:var(--muted);}
.ob-notif-box{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:18px;margin-bottom:20px;text-align:center;}
.ob-notif-icon{font-size:32px;margin-bottom:10px;}
.ob-notif-title{font-family:var(--font-display);font-size:17px;margin-bottom:8px;}
.ob-notif-desc{font-size:13px;color:var(--muted);line-height:1.6;}
@media(max-width:480px){.ob-card{padding:28px 20px;}}
`;

function reducer(state, action) {
  switch(action.type) {
    case "ADD_COURSE":    { const id=action.id||newSyncId(); return {...state,courses:{...state.courses,[id]:{id,name:action.name,color:action.color,notes:[],credits:action.credits??1,semester:action.semester??null,updatedAt:action.updatedAt||new Date().toISOString(),deletedAt:null}}}; }
    case "EDIT_COURSE":  return {...state,courses:{...state.courses,[action.id]:{...state.courses[action.id],name:action.name,color:action.color,credits:action.credits!==undefined?action.credits:state.courses[action.id]?.credits,semester:action.semester!==undefined?action.semester:state.courses[action.id]?.semester,updatedAt:new Date().toISOString()}}};
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
    case "ADD_ASSIGNMENT":  { const a={id:uid(),courseId:action.courseId,title:action.title,type:action.assignType,dueDate:action.dueDate,notes:action.notes||"",done:false}; return {...state,assignments:[...state.assignments,a]}; }
    case "TOGGLE_ASSIGNMENT": return {...state,assignments:state.assignments.map(a=>a.id===action.id?{...a,done:!a.done}:a)};
    case "EDIT_ASSIGNMENT":   return {...state,assignments:state.assignments.map(a=>a.id===action.id?{...a,title:action.title,dueDate:action.dueDate,notes:action.notes}:a)};
    case "DELETE_ASSIGNMENT": return {...state,assignments:state.assignments.filter(a=>a.id!==action.id)};
    case "ADD_EXAM":    { const e={id:uid(),courseId:action.courseId,title:action.title,dueDate:action.dueDate,difficulty:action.difficulty||"medium",notes:action.notes||"",done:false,topics:[]}; return {...state,exams:[...state.exams,e]}; }
    case "TOGGLE_EXAM": return {...state,exams:state.exams.map(e=>e.id===action.id?{...e,done:!e.done}:e)};
    case "DELETE_EXAM": return {...state,exams:state.exams.filter(e=>e.id!==action.id)};
    case "UPDATE_EXAM_DIFFICULTY": return {...state,exams:state.exams.map(e=>e.id===action.id?{...e,difficulty:action.difficulty}:e)};
    case "ADD_EXAM_TOPIC":    return {...state,exams:state.exams.map(e=>e.id===action.examId?{...e,topics:[...(e.topics||[]),{id:uid(),title:action.title,done:false}]}:e)};
    case "TOGGLE_EXAM_TOPIC": return {...state,exams:state.exams.map(e=>e.id===action.examId?{...e,topics:(e.topics||[]).map(t=>t.id===action.topicId?{...t,done:!t.done}:t)}:e)};
    case "DELETE_EXAM_TOPIC": return {...state,exams:state.exams.map(e=>e.id===action.examId?{...e,topics:(e.topics||[]).filter(t=>t.id!==action.topicId)}:e)};
    case "ADD_ACTION":    { const a={id:uid(),text:action.text,bucket:action.bucket||"today",courseId:action.courseId||null,done:false,suggested:action.suggested||false,sourceId:action.sourceId||null}; return {...state,actions:[...state.actions,a]}; }
    case "TOGGLE_ACTION": return {...state,actions:state.actions.map(a=>a.id===action.id?{...a,done:!a.done,doneAt:!a.done?Date.now():null}:a)};
    case "DELETE_ACTION": return {...state,actions:state.actions.filter(a=>a.id!==action.id)};
    case "SET_VIEW":      return {...state,view:action.view,activeCourse:action.course!==undefined?action.course:state.activeCourse};

    // ── Grades (new schema: per-grade rows linked to a subject) ──
    case "ADD_GRADE":    { const g={id:action.id||newSyncId(),subjectId:action.subjectId,grade:Number(action.grade),weight:Number(action.weight??1),date:action.date||new Date().toISOString().slice(0,10),updatedAt:action.updatedAt||new Date().toISOString(),deletedAt:null}; return {...state,grades:[...(state.grades||[]),g]}; }
    case "EDIT_GRADE":   return {...state,grades:(state.grades||[]).map(g=>g.id===action.id?{...g,subjectId:action.subjectId??g.subjectId,grade:action.grade!==undefined?Number(action.grade):g.grade,weight:action.weight!==undefined?Number(action.weight):g.weight,date:action.date??g.date,updatedAt:new Date().toISOString()}:g)};
    case "DELETE_GRADE": { const stamp=new Date().toISOString(); return {...state,grades:(state.grades||[]).map(g=>g.id===action.id?{...g,deletedAt:stamp,updatedAt:stamp}:g)}; }

    // ── Study sessions ──
    case "ADD_SESSION":    { const s={id:action.id||newSyncId(),subjectId:action.subjectId||null,startedAt:action.startedAt,durationMinutes:Math.max(1,Math.min(1440,Math.round(action.durationMinutes))),notes:action.notes||null,updatedAt:action.updatedAt||new Date().toISOString(),deletedAt:null}; return {...state,studySessions:[...(state.studySessions||[]),s]}; }
    case "EDIT_SESSION":   return {...state,studySessions:(state.studySessions||[]).map(s=>s.id===action.id?{...s,subjectId:action.subjectId!==undefined?(action.subjectId||null):s.subjectId,startedAt:action.startedAt??s.startedAt,durationMinutes:action.durationMinutes!==undefined?Math.max(1,Math.min(1440,Math.round(action.durationMinutes))):s.durationMinutes,notes:action.notes!==undefined?(action.notes||null):s.notes,updatedAt:new Date().toISOString()}:s)};
    case "DELETE_SESSION": { const stamp=new Date().toISOString(); return {...state,studySessions:(state.studySessions||[]).map(s=>s.id===action.id?{...s,deletedAt:stamp,updatedAt:stamp}:s)}; }

    // ── Settings ──
    case "SET_GRADE_MODE": return {...state,gradeMode:action.mode==="us"?"us":"ib"};

    // ── Sync: bulk merge from Supabase pull (LWW logic in merge.js) ──
    case "MERGE_REMOTE":   return applyRemotePull(state, action.remote);

    default: return state;
  }
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
h1,h2,h3,h4,h5,h6{font-weight:inherit;font-size:inherit;}
:root{--bg:#f5f2ed;--surface:#faf8f4;--surface2:#f0ece4;--border:#e0d9cf;--border2:#cfc8bc;--text:#1a1814;--muted:#6b6560;--muted2:#7a7570;--font-display:'Playfair Display',serif;--font-mono:'DM Mono',monospace;--font-sans:'DM Sans',sans-serif;--shadow:0 1px 3px rgba(0,0,0,0.08);--shadow-md:0 4px 12px rgba(0,0,0,0.08);}
html,body,#root{height:100%;background:var(--bg);color:var(--text);font-family:var(--font-sans);overscroll-behavior:none;}
/* Paper grain texture overlay */
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:0.035;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");background-repeat:repeat;background-size:128px 128px;}
::selection{background:#d4c9b8;}
::-webkit-scrollbar{width:5px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px;}
*:focus-visible{outline:2px solid var(--text);outline-offset:2px;border-radius:2px;}

/* ── Desktop layout ── */
.app{display:flex;height:100vh;overflow:hidden;}
.sidebar{width:240px;min-width:240px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;transition:none;}
.sidebar-header{padding:24px 20px 16px;border-bottom:1px solid var(--border);}
.sidebar-logo-wrap{display:flex;align-items:center;gap:12px;}
.sidebar-logo{width:40px;height:40px;border-radius:10px;flex-shrink:0;}
.sidebar-wordmark{font-family:var(--font-display);font-size:20px;font-weight:600;}
.sidebar-sub{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-top:3px;letter-spacing:0.05em;}
.sidebar-nav{padding:12px 0;border-bottom:1px solid var(--border);}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:13px;cursor:pointer;color:var(--muted);transition:all 0.1s;border-left:2px solid transparent;}
.nav-item:hover{color:var(--text);background:var(--surface2);}
.nav-item.active{color:var(--text);border-left-color:var(--text);background:var(--surface2);}
.sidebar-courses{flex:1;overflow-y:auto;padding:12px 0;}
.courses-label{padding:4px 20px 8px;font-family:var(--font-mono);font-size:9px;letter-spacing:0.12em;color:var(--muted2);text-transform:uppercase;}
.course-item{display:flex;align-items:center;gap:10px;padding:8px 20px;cursor:pointer;font-size:13px;transition:background 0.1s;border-left:2px solid transparent;}
.course-item:hover{background:var(--surface2);}
.course-item.active{background:var(--surface2);border-left-color:var(--text);}
.course-pip{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.course-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.course-count{font-family:var(--font-mono);font-size:10px;color:var(--muted2);}
.course-edit-btn{opacity:0;font-size:13px;color:var(--muted);cursor:pointer;padding:0 2px;transition:opacity 0.1s,color 0.1s;line-height:1;}
.course-item:hover .course-edit-btn{opacity:1;}
.course-edit-btn:hover{color:var(--text);}
.add-course-btn{display:flex;align-items:center;gap:8px;padding:8px 20px;color:var(--muted);font-size:12px;cursor:pointer;transition:color 0.1s;}
.add-course-btn:hover{color:var(--text);}
.main{flex:1;overflow-y:auto;display:flex;flex-direction:column;background:var(--bg);}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:18px 32px;border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:0;z-index:10;}
.topbar-title{font-family:var(--font-display);font-size:22px;font-weight:500;}
.topbar-date{font-family:var(--font-mono);font-size:11px;color:var(--muted);}
.content{padding:32px;flex:1;max-width:900px;width:100%;margin:0 auto;}
@media(max-width:768px){
  .content{padding:16px 14px;max-width:100%;margin:0;}
}

/* ── Mobile layout — fixed bottom tab bar ── */
@media(max-width:768px){
  .app{display:block;height:100dvh;overflow:hidden;position:relative;}
  /* Hide entire sidebar on mobile — tab bar is fixed, not inside sidebar */
  .sidebar{display:none;}
  /* Main scrolls within remaining space above the fixed tab bar */
  .main{height:100dvh;overflow-y:auto;padding-bottom:calc(64px + env(safe-area-inset-bottom));}
  .topbar{padding:14px 16px 12px;position:sticky;top:0;z-index:10;}
  .topbar-title{font-size:18px;}
  .content{padding:16px 14px;max-width:100%;}
  /* Fixed bottom tab bar — always at the bottom, never overlaps status bar */
  .mobile-tabbar{
    display:flex;
    position:fixed;
    bottom:0;
    left:0;
    right:0;
    z-index:50;
    background:var(--surface);
    border-top:1px solid var(--border);
    padding-bottom:env(safe-area-inset-bottom);
  }
  .mobile-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 4px 12px;cursor:pointer;color:var(--muted);font-size:9px;font-family:var(--font-mono);letter-spacing:0.04em;gap:4px;border-top:2px solid transparent;transition:all 0.1s;-webkit-tap-highlight-color:transparent;}
  .mobile-tab:active{background:var(--surface2);}
  .mobile-tab.active{color:var(--text);border-top-color:var(--text);}
  .mobile-tab-icon{font-size:18px;line-height:1;}
  /* Course strip — fixed just above the tab bar */
  .mobile-courses-bar{
    display:flex;align-items:center;
    position:fixed;
    bottom:calc(64px + env(safe-area-inset-bottom));
    left:0;right:0;
    z-index:49;
    background:var(--surface);
    border-top:1px solid var(--border);
    overflow:hidden;
    transition:max-height 0.25s ease;
    max-height:0;
  }
  .mobile-courses-bar.open{max-height:56px;}
  .mobile-courses-scroll{display:flex;gap:6px;padding:10px 14px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex:1;}
  .mobile-courses-scroll::-webkit-scrollbar{display:none;}
  .mobile-course-chip{display:flex;align-items:center;gap:6px;padding:6px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:20px;white-space:nowrap;font-size:12px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;}
  .mobile-course-chip.active{border-color:var(--text);}
  .mobile-course-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
  .mobile-course-add{padding:6px 12px;background:transparent;border:1px dashed var(--border2);border-radius:20px;font-size:12px;color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0;}
}
@media(min-width:769px){
  .mobile-tabbar,.mobile-courses-bar{display:none!important;}
}
`;

const css2 = `
/* ── Shared components ── */
input[type=text],input[type=date],select,textarea{background:var(--surface);border:1px solid var(--border2);color:var(--text);padding:9px 12px;font-family:var(--font-sans);font-size:13px;border-radius:4px;outline:none;transition:border-color 0.15s;width:100%;}
input[type=text]:focus,input[type=date]:focus,select:focus,textarea:focus{border-color:#aaa;}
textarea{resize:vertical;min-height:80px;line-height:1.6;}select{cursor:pointer;}
.input-group{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}
.input-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;color:var(--muted);text-transform:uppercase;}
.input-row{display:flex;gap:8px;align-items:flex-start;}
.btn{background:#3d2e1e;color:#faf8f4;border:none;padding:9px 18px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;border-radius:4px;transition:opacity 0.1s;white-space:nowrap;font-weight:500;}
.btn:hover{opacity:0.8;}.btn-sm{padding:6px 12px;font-size:10px;}
.btn-outline{background:transparent;color:var(--muted);border:1px solid var(--border2);padding:7px 14px;font-family:var(--font-mono);font-size:10px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;border-radius:4px;transition:all 0.1s;}
.btn-outline:hover{color:var(--text);border-color:var(--text);}
.btn-danger-text{background:none;border:none;color:var(--muted2);cursor:pointer;font-size:16px;padding:2px 6px;transition:color 0.1s;}
.btn-danger-text:hover{color:#c0392b;}
.btn-red{background:#c0392b;color:#fff;border:none;padding:8px 16px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;border-radius:4px;transition:opacity 0.1s;}
.btn-red:hover{opacity:0.85;}
.section-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:10px;}
.section-label::after{content:'';flex:1;height:1px;background:var(--border);}
.asgn-item{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:5px;margin-bottom:8px;box-shadow:var(--shadow);}
.asgn-item.done{opacity:0.45;}
.asgn-check{width:17px;height:17px;border:1.5px solid var(--border2);border-radius:3px;flex-shrink:0;margin-top:2px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;}
.asgn-check:hover{border-color:var(--text);}
.asgn-check.checked{background:var(--text);border-color:var(--text);}
.asgn-check.checked::after{content:'';display:block;width:4px;height:7px;border:2px solid var(--bg);border-top:none;border-left:none;transform:rotate(45deg) translate(-1px,-1px);}
.asgn-body{flex:1;min-width:0;}
.asgn-title{font-size:14px;font-weight:500;margin-bottom:4px;}
.asgn-title.done{text-decoration:line-through;color:var(--muted);}
.asgn-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.asgn-course{font-family:var(--font-mono);font-size:10px;font-weight:500;padding:2px 7px;border-radius:20px;}
.asgn-type{font-family:var(--font-mono);font-size:10px;color:var(--muted);}
.asgn-due{font-family:var(--font-mono);font-size:10px;font-weight:500;}
.asgn-notes{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.5;}
.tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-family:var(--font-mono);font-size:10px;font-weight:500;}
.tag-exam{background:rgba(109,63,160,0.12);color:#6d3fa0;}
.action-item{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;background:var(--surface);border:1px solid var(--border);border-radius:5px;margin-bottom:6px;box-shadow:var(--shadow);}
.action-item.done{opacity:0.4;}
.action-item.suggested{border-style:dashed;background:rgba(26,92,158,0.04);}
.action-text{flex:1;font-size:13px;line-height:1.5;}
.action-text.done{text-decoration:line-through;color:var(--muted);}
.bucket-section{margin-bottom:24px;}
.bucket-header{font-family:var(--font-mono);font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:10px;}
.bucket-header::after{content:'';flex:1;height:1px;background:var(--border);}
.bucket-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.modal-overlay{position:fixed;inset:0;background:rgba(26,24,20,0.5);z-index:100;display:flex;align-items:center;justify-content:center;animation:fadeOverlay 0.15s ease;}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:28px;width:500px;max-width:94vw;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-md);animation:slideModal 0.15s ease;}
@keyframes fadeOverlay{from{opacity:0;}to{opacity:1;}}
@keyframes slideModal{from{opacity:0;transform:translateY(10px) scale(0.98);}to{opacity:1;transform:translateY(0) scale(1);}}
.modal-title{font-family:var(--font-display);font-size:18px;margin-bottom:20px;}
.modal-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.urgent-banner{background:rgba(192,57,43,0.08);border:1px solid rgba(192,57,43,0.25);border-radius:5px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:10px;font-size:13px;}
.urgent-banner strong{color:#c0392b;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;}
.empty{color:var(--muted2);font-family:var(--font-mono);font-size:11px;padding:20px 0;}
.divider{height:1px;background:var(--border);margin:24px 0;}
.flash{position:fixed;bottom:24px;right:24px;background:var(--text);color:var(--bg);padding:10px 18px;font-family:var(--font-mono);font-size:11px;border-radius:4px;animation:fadeup 0.2s ease;z-index:200;}
@keyframes fadeup{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
@media(max-width:768px){
  .flash{bottom:calc(72px + env(safe-area-inset-bottom));right:14px;}
  .modal-grid{grid-template-columns:1fr;}
  .input-row{flex-direction:column;align-items:stretch;}
  .btn,.btn-outline{text-align:center;}
}
`;

const css3 = `
/* ── Home course cards ── */
.home-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-bottom:28px;}
.course-card{background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:var(--shadow);border-left:3px solid transparent;overflow:hidden;}
.course-card-compact{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;transition:background 0.1s;user-select:none;}
.course-card-compact:hover{background:var(--surface2);}
.course-card-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0;}
.course-card-name{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.course-card-pills{display:flex;gap:5px;flex-shrink:0;}
.course-card-pill{font-family:var(--font-mono);font-size:9px;padding:2px 7px;border-radius:20px;background:var(--surface2);color:var(--muted);border:1px solid var(--border);}
.course-card-pill.urgent{background:rgba(192,57,43,0.1);color:#c0392b;border-color:rgba(192,57,43,0.2);}
.course-card-chevron{font-size:10px;color:var(--muted2);transition:transform 0.2s;flex-shrink:0;margin-left:6px;}
.course-card-chevron.open{transform:rotate(90deg);}
.course-card-detail{border-top:1px solid var(--border);padding:12px 16px 14px;background:var(--surface2);}
.course-card-next{font-size:12px;color:var(--muted);line-height:1.7;}
.course-card-actions{display:flex;gap:8px;margin-top:10px;}

/* ── Exam cards ── */
.exam-card{background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:12px;box-shadow:var(--shadow);border-left:4px solid transparent;overflow:hidden;}
.exam-card.done{opacity:0.5;}
.exam-card-header{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;cursor:pointer;user-select:none;}
.exam-card-header:hover{background:rgba(0,0,0,0.018);}
.exam-card-header-info{flex:1;min-width:0;}
.exam-card-title{font-size:15px;font-weight:600;margin-bottom:6px;}
.exam-card-title.done{text-decoration:line-through;color:var(--muted);}
.exam-card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.exam-card-body{padding:0 18px 18px;border-top:1px solid var(--border);}
.exam-card-notes{font-size:12px;color:var(--muted);line-height:1.5;padding-top:12px;margin-bottom:10px;}
.exam-header-progress{display:flex;align-items:center;gap:8px;margin-top:7px;}
.exam-header-progress-track{flex:1;height:4px;background:var(--border);border-radius:99px;overflow:hidden;max-width:120px;}
.exam-header-progress-fill{height:100%;border-radius:99px;transition:width 0.3s;}
.exam-header-progress-txt{font-family:var(--font-mono);font-size:10px;color:var(--muted2);white-space:nowrap;}
.study-plan-bar{background:var(--surface2);border-radius:4px;padding:10px 12px;margin:12px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.study-plan-label{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:0.05em;}
.study-plan-date{font-family:var(--font-mono);font-size:11px;font-weight:500;}
.difficulty-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-family:var(--font-mono);font-size:10px;font-weight:500;cursor:pointer;border:1px solid transparent;transition:all 0.1s;}
.topics-section{padding-top:8px;}
.topics-section-header{display:flex;align-items:center;gap:10px;margin-bottom:14px;}
.topics-section-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;color:var(--muted);text-transform:uppercase;white-space:nowrap;}
.topics-big-progress-wrap{flex:1;height:6px;background:var(--border);border-radius:99px;overflow:hidden;}
.topics-big-progress-bar{height:100%;border-radius:99px;transition:width 0.35s;}
.topics-big-progress-txt{font-family:var(--font-mono);font-size:11px;color:var(--muted);white-space:nowrap;}
.topic-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:5px;margin-bottom:4px;cursor:pointer;transition:background 0.1s;}
.topic-item:hover{background:var(--surface2);}
.topic-check{width:20px;height:20px;border:2px solid var(--border2);border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all 0.15s;}
.topic-check:hover{border-color:var(--text);}
.topic-check.checked{background:var(--text);border-color:var(--text);}
.topic-check.checked::after{content:'';display:block;width:5px;height:8px;border:2px solid var(--bg);border-top:none;border-left:none;transform:rotate(45deg) translate(-1px,-1px);}
.topic-title{font-size:14px;flex:1;line-height:1.4;}
.topic-title.done{text-decoration:line-through;color:var(--muted2);}
.topic-del{opacity:0;background:none;border:none;color:var(--muted2);cursor:pointer;font-size:16px;padding:0 4px;transition:opacity 0.1s,color 0.1s;}
.topic-item:hover .topic-del{opacity:1;}
.topic-del:hover{color:#c0392b;}
.topics-empty{font-family:var(--font-mono);font-size:11px;color:var(--muted2);padding:14px 12px;text-align:center;border:1px dashed var(--border);border-radius:5px;margin-bottom:12px;}
.topic-add-row{display:flex;gap:6px;margin-top:6px;}
.topic-add-row input{font-size:13px;padding:9px 12px;}
.topic-add-btn{background:var(--text);color:var(--bg);border:none;padding:9px 16px;font-family:var(--font-mono);font-size:10px;border-radius:4px;cursor:pointer;white-space:nowrap;transition:opacity 0.1s;}
.topic-add-btn:hover{opacity:0.8;}

/* ── Calendar — desktop grid, mobile agenda ── */
.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:24px;}
.cal-header{font-family:var(--font-mono);font-size:10px;color:var(--muted);text-align:center;padding:4px 0;letter-spacing:0.05em;}
.cal-day{min-height:64px;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:4px 6px;}
.cal-day.today{border-color:var(--text);}
.cal-day.other-month{opacity:0.35;}
.cal-day-num{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-bottom:3px;}
.cal-day.today .cal-day-num{color:var(--text);font-weight:600;}
.cal-event{font-size:9px;padding:2px 5px;border-radius:3px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono);font-weight:500;}
.cal-exam{background:rgba(109,63,160,0.15);color:#6d3fa0;}
.cal-study{background:rgba(26,92,158,0.12);color:#1a5c9e;}
/* Mobile agenda replaces grid */
.cal-agenda{display:none;}
.cal-agenda-item{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);}
.cal-agenda-date{font-family:var(--font-mono);font-size:11px;color:var(--muted);width:54px;flex-shrink:0;padding-top:2px;}
.cal-agenda-pills{display:flex;flex-direction:column;gap:5px;flex:1;}
.cal-agenda-pill{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:4px;font-size:12px;}
@media(max-width:600px){
  .calendar-grid,.cal-header-row{display:none!important;}
  .cal-agenda{display:block;}
}

.nextup-unlock{display:flex;gap:16px;align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px;box-shadow:var(--shadow);}
.nextup-unlock-icon{font-size:28px;color:var(--border2);flex-shrink:0;margin-top:2px;}
.nextup-unlock-body{flex:1;}
.nextup-unlock-title{font-family:var(--font-display);font-size:17px;font-weight:500;color:var(--text);margin-bottom:8px;line-height:1.35;}
.nextup-unlock-sub{font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:16px;}
.nextup-unlock-progress{display:flex;align-items:center;gap:8px;margin-bottom:16px;}
.nextup-unlock-pip{width:32px;height:6px;border-radius:3px;background:var(--border2);transition:background 0.25s;}
.nextup-unlock-pip.filled{background:#2e7d52;}
.nextup-unlock-progress-label{font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-left:4px;}
.suggest-banner{background:rgba(26,92,158,0.06);border:1px dashed rgba(26,92,158,0.3);border-radius:5px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;font-size:13px;flex-wrap:wrap;}
.suggest-banner-label{font-family:var(--font-mono);font-size:9px;letter-spacing:0.1em;color:#1a5c9e;margin-right:4px;}
.quick-add-box{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:24px;box-shadow:var(--shadow);}
@media(max-width:768px){
  .home-grid{grid-template-columns:1fr;}
  .quick-add-box .input-row{flex-direction:row;}
  .quick-add-box .input-row select{max-width:110px;}
  .study-plan-bar{flex-direction:column;align-items:flex-start;gap:6px;}
  .topic-item{padding:12px 10px;}
}
`;

const css4 = `
/* ── Pomodoro Timer ── */
.pomo-time{font-family:var(--font-display);font-size:48px;font-weight:500;letter-spacing:-0.02em;line-height:1;}
.pomo-phase{font-family:var(--font-mono);font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);}
.pomo-controls{display:flex;gap:12px;margin-bottom:28px;align-items:center;}
.pomo-btn-main{background:var(--text);color:var(--bg);border:none;width:56px;height:56px;border-radius:50%;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity 0.1s;box-shadow:var(--shadow-md);}
.pomo-btn-main:hover{opacity:0.8;}
.pomo-btn-sec{background:transparent;color:var(--muted);border:1px solid var(--border2);width:40px;height:40px;border-radius:50%;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.1s;align-self:center;}
.pomo-btn-sec:hover{color:var(--text);border-color:var(--text);}
.pomo-segments{display:flex;gap:6px;margin-bottom:28px;}
.pomo-seg{width:10px;height:10px;border-radius:50%;background:var(--border);transition:background 0.3s;}
.pomo-seg.done{background:var(--text);}
.pomo-seg.current{background:var(--muted);}
.pomo-presets{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:28px;}
.pomo-preset-btn{font-family:var(--font-mono);font-size:10px;padding:6px 14px;border-radius:20px;border:1px solid var(--border2);background:transparent;color:var(--muted);cursor:pointer;transition:all 0.1s;letter-spacing:0.05em;}
.pomo-preset-btn.active{background:var(--text);color:var(--bg);border-color:var(--text);}
.pomo-task-row{width:100%;max-width:380px;display:flex;flex-direction:column;gap:8px;}
.pomo-task-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;color:var(--muted);text-transform:uppercase;}
.pomo-session-log{width:100%;max-width:380px;margin-top:24px;}
.pomo-log-entry{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted);}
.pomo-log-badge{font-family:var(--font-mono);font-size:9px;padding:2px 8px;border-radius:20px;background:var(--surface2);border:1px solid var(--border);white-space:nowrap;}
.pomo-ring-wrap{position:relative;width:220px;height:220px;margin:0 auto 28px auto;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
.pomo-ring-svg{position:absolute;top:0;left:0;width:100%;height:100%;}
.pomo-ring-label{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;pointer-events:none;width:100%;}
@media(max-width:480px){
  .pomo-ring-wrap{width:200px;height:200px;}
}
/* ── Paused-state ring ── */
.pomo-btn-main{position:relative;}
.pomo-btn-main.paused::after{content:'';position:absolute;inset:-7px;border-radius:50%;border:2px dashed var(--text);opacity:0.28;animation:pomo-spin-ring 10s linear infinite;}
@keyframes pomo-spin-ring{to{transform:rotate(360deg);}}
/* ── Timer-complete animation ── */
.pomo-ring-done{animation:ring-pulse 0.8s ease;}
@keyframes ring-pulse{0%{transform:scale(1);}45%{transform:scale(1.05);}100%{transform:scale(1);}}
.pomo-time-flash{animation:time-flash 0.7s ease;}
@keyframes time-flash{0%{opacity:1;}35%{opacity:0.2;}100%{opacity:1;}}

/* ── Lock In: entry button on the regular timer ── */
.lockin-enter{margin-top:18px;background:#1a1814;color:#faf8f4;border:1px solid #1a1814;padding:10px 22px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;border-radius:99px;transition:transform 0.1s,opacity 0.1s;}
.lockin-enter:hover{opacity:0.85;transform:scale(1.02);}
.lockin-enter:active{transform:scale(0.98);}

/* ── Lock In takeover (full-screen, dark, distraction-stripped) ── */
.lockin-wrap{position:fixed;inset:0;z-index:50;background:radial-gradient(ellipse at center, #1f1c17 0%, #0e0c09 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:40px 20px;color:#faf8f4;animation:lockin-fade 0.3s ease;}
@keyframes lockin-fade{from{opacity:0;}to{opacity:1;}}
.lockin-top{position:absolute;top:32px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;}
.lockin-badge{font-family:var(--font-mono);font-size:10px;letter-spacing:0.35em;color:rgba(250,248,244,0.45);}
.lockin-task{font-family:var(--font-display);font-size:18px;color:rgba(250,248,244,0.85);max-width:80vw;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lockin-ring{width:260px;height:260px;margin:0;}
.lockin-ring .pomo-time{font-size:56px;letter-spacing:-0.02em;}
.lockin-task-input{background:transparent;border:none;border-bottom:1px solid rgba(250,248,244,0.15);color:#faf8f4;padding:10px 4px;font-family:var(--font-display);font-size:17px;text-align:center;width:min(360px,80vw);outline:none;transition:border-color 0.15s;}
.lockin-task-input:focus{border-bottom-color:rgba(250,248,244,0.45);}
.lockin-task-input::placeholder{color:rgba(250,248,244,0.3);}
.lockin-controls{display:flex;justify-content:center;}
.lockin-btn-main{background:#faf8f4;color:#1a1814;border:none;width:72px;height:72px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.1s,opacity 0.1s;box-shadow:0 4px 24px rgba(0,0,0,0.5);}
.lockin-btn-main:hover{opacity:0.9;transform:scale(1.04);}
.lockin-btn-main:active{transform:scale(0.96);}
.lockin-presets{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.lockin-preset{background:transparent;color:rgba(250,248,244,0.5);border:1px solid rgba(250,248,244,0.2);padding:6px 14px;font-family:var(--font-mono);font-size:10px;letter-spacing:0.08em;border-radius:99px;cursor:pointer;transition:all 0.1s;}
.lockin-preset.active{background:rgba(250,248,244,0.12);color:#faf8f4;border-color:rgba(250,248,244,0.4);}
.lockin-preset:disabled{opacity:0.3;cursor:not-allowed;}
.lockin-exit{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);background:transparent;border:1px solid rgba(250,248,244,0.18);color:rgba(250,248,244,0.55);padding:9px 22px;font-family:var(--font-mono);font-size:10px;letter-spacing:0.18em;text-transform:uppercase;cursor:pointer;border-radius:99px;transition:all 0.15s;}
.lockin-exit:hover{color:#faf8f4;border-color:rgba(250,248,244,0.45);}

/* While locked in, hide the desktop sidebar and mobile tab bar so nothing pulls focus */
body.locked-in .sidebar,body.locked-in .mobile-tabbar,body.locked-in .topbar{display:none !important;}
body.locked-in .main{padding:0;}
body.locked-in .content{padding:0;max-width:none;}
`;

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL, (init) => {
    try {
      const raw = localStorage.getItem("studydesk-v1");
      const saved = raw ? JSON.parse(raw) : {};
      // Normalize legacy course rows that pre-date credits/semester/timestamps.
      const courses = {};
      for (const [id, c] of Object.entries(saved.courses || {})) {
        courses[id] = {
          notes: [],
          credits: 1,
          semester: null,
          updatedAt: null,
          deletedAt: null,
          ...c,
        };
      }
      const gradeMode = (() => {
        try { return localStorage.getItem("studydesk-grade-mode") === "us" ? "us" : "ib"; } catch { return "ib"; }
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
      const migratedGrades = (saved.grades || []).map(g => {
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
      const migratedSessions = (saved.studySessions || []).map(s => {
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
      // Assignments, exams, actions are local-only but reference courseId — update.
      const migratedAssignments = (saved.assignments || []).map(a =>
        subjectIdMap[a.courseId] && subjectIdMap[a.courseId] !== a.courseId
          ? { ...a, courseId: subjectIdMap[a.courseId] }
          : a);
      const migratedExams = (saved.exams || []).map(e =>
        subjectIdMap[e.courseId] && subjectIdMap[e.courseId] !== e.courseId
          ? { ...e, courseId: subjectIdMap[e.courseId] }
          : e);
      const migratedActions = (saved.actions || []).map(a =>
        a.courseId && subjectIdMap[a.courseId] && subjectIdMap[a.courseId] !== a.courseId
          ? { ...a, courseId: subjectIdMap[a.courseId] }
          : a);
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
        activeCourse: migratedActiveCourse,
        gradeMode,
        view: "actions",
      };
    } catch { return init; }
  });
  const [onboarded, setOnboarded] = useState(() => {
    try { return localStorage.getItem("studydesk-onboarded") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("studydesk-v1", JSON.stringify({
      courses:state.courses,
      assignments:state.assignments,
      actions:state.actions,
      exams:state.exams,
      grades:state.grades,
      studySessions:state.studySessions,
    })); } catch {}
  }, [state.courses,state.assignments,state.actions,state.exams,state.grades,state.studySessions]);
  // gradeMode is UI-only — persist separately so it doesn't trigger a v1 rewrite on every toggle.
  useEffect(() => {
    try { localStorage.setItem("studydesk-grade-mode", state.gradeMode); } catch {}
  }, [state.gradeMode]);

  // Schedule notifications after onboarding with fresh state (#21 fix)
  // Reschedule notifications whenever exams or assignments change (not just onboarding)
  useEffect(() => {
    if (onboarded) {
      scheduleNotifications(state.exams, state.assignments, state.courses);
    }
  }, [onboarded, state.exams, state.assignments]);
  // Notifications are only scheduled after onboarding completes — never on first open
  const handleOnboardingComplete = useCallback((courseData) => {
    if (courseData) {
      dispatch({type:"ADD_COURSE", name:courseData.name, color:courseData.color});
    }
    try { localStorage.setItem("studydesk-onboarded","1"); } catch {}
    setOnboarded(true);
    // Notifications scheduled via useEffect watching onboarded — avoids stale closure (#21)
  }, []);

  const [flash, setFlash] = useState(null);
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [showAddAsgn, setShowAddAsgn] = useState(false);
  const [showAddExam, setShowAddExam] = useState(false);
  const [newCourseName, setNewCourseName] = useState("");
  const [colorIdx, setColorIdx] = useState(0);
  const [showMobileCourses, setShowMobileCourses] = useState(false);
  const showFlash = useCallback((msg) => { setFlash(msg); setTimeout(()=>setFlash(null),2200); }, []);

  // ── Auth session ─────────────────────────────────────────────────────────────
  const [session, setSession] = useState(undefined); // undefined = loading; null = signed out; object = signed in
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── Sync: initial pull + Realtime, gated on sign-in ─────────────────────────
  useEffect(() => {
    if (!session) { sync.stopRealtime(); return; }
    let cancelled = false;
    const doPull = async () => {
      try {
        const remote = await sync.pullAllStudyData();
        if (!cancelled) dispatch({ type: "MERGE_REMOTE", remote });
      } catch (e) {
        console.error("[StudyDesk] pull failed:", e);
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
          await sync.upsertSubject({ id: c.id, name: c.name, credits: c.credits, semester: c.semester, color: c.color });
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
      if (failed === 0) {
        try { localStorage.removeItem("studydesk-needs-initial-push"); } catch {}
        if (pushed > 0) showFlash(`Synced ${pushed} legacy items`);
      } else {
        showFlash(`${pushed} synced, ${failed} failed — will retry`);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const signOut = useCallback(async () => {
    try { await supabase.auth.signOut(); } catch (e) { showFlash("Sign-out failed: "+e.message); }
  }, [showFlash]);

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
  const todayStr = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"});
  const urgent = state.assignments.filter(a=>{ if(a.done) return false; const d=daysUntil(a.dueDate); return d!==null&&d<=0; });
  const urgentExams = state.exams.filter(e=>!e.done&&daysUntil(e.dueDate)!==null&&daysUntil(e.dueDate)<=3);
  const addCourse = () => {
    if(!newCourseName.trim()) return;
    const id = newSyncId();
    const name = newCourseName.trim();
    const color = COURSE_COLORS[colorIdx%COURSE_COLORS.length];
    dispatch({type:"ADD_COURSE", id, name, color});
    setColorIdx(i=>i+1); setNewCourseName(""); setShowAddCourse(false); showFlash("Course added");
    if (session) {
      sync.upsertSubject({ id, name, color }).catch(e => showFlash("Sync failed: " + e.message));
    }
  };

  const views = [
    {id:"actions",  label:"Study",   icon:"◎"},
    {id:"plan",     label:"Plan",    icon:"◈"},
    {id:"grades",   label:"Grades",  icon:"⌗"},
    {id:"timer",    label:"Timer",   icon:"◉"},
    {id:"log",      label:"Log",     icon:"≡"},
    {id:"settings", label:"Settings",icon:"⚙"},
  ];
  const activeView = views.find(v=>v.id===state.view);

  // Auth gate: show login UI until Supabase confirms a session.
  // (session === undefined while the initial getSession() call is in flight.)
  if (session === undefined) {
    return <><style>{css+css2+css3+css4+cssOnboard}</style><div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",letterSpacing:"0.1em"}}>LOADING…</div></>;
  }
  if (session === null) {
    return <><style>{css+css2+css3+css4+cssOnboard}</style><AuthGate/></>;
  }

  return (<>
    <style>{css+css2+css3+css4+cssOnboard}</style>
    {!onboarded && <OnboardingView onComplete={handleOnboardingComplete}/>}
    {onboarded && (
      <div className="app">
      {/* ── Desktop sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo-wrap">
            <img src="/logo.png" alt="StudyDesk" className="sidebar-logo" />
            <div>
              <div className="sidebar-wordmark">Studydesk</div>
              <div className="sidebar-sub">academic focus tool</div>
            </div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {views.map(v=><div key={v.id} role="button" tabIndex={0} className={"nav-item"+(state.view===v.id?" active":"")} onClick={()=>dispatch({type:"SET_VIEW",view:v.id})} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:v.id})}>
            <span style={{width:16,textAlign:"center",fontSize:13}}>{v.icon}</span>{v.label}
          </div>)}
        </nav>
        <div className="sidebar-courses">
          {courses.length>0&&<div className="courses-label">Courses</div>}
          {courses.map(c=>{
            const open=state.assignments.filter(a=>a.courseId===c.id&&!a.done).length;
            const exams=state.exams.filter(e=>e.courseId===c.id&&!e.done).length;
            return <div key={c.id} role="button" tabIndex={0} className={"course-item"+(state.activeCourse===c.id?" active":"")} onClick={()=>dispatch({type:"SET_VIEW",view:"status",course:c.id})} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:"status",course:c.id})}>
              <div className="course-pip" style={{background:c.color}}/><span className="course-name">{c.name}</span>
              {(open+exams)>0&&<span className="course-count">{open+exams}</span>}
              <span className="course-edit-btn" onClick={e=>{e.stopPropagation();setEditingCourse({id:c.id,name:c.name,color:c.color});}} title="Edit">✎</span>
            </div>;
          })}
          <div className="add-course-btn" onClick={()=>setShowAddCourse(true)}><span style={{fontSize:16}}>+</span> Add Course</div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="main">
        <div className="topbar">
          <h1 className="topbar-title">{state.view==="actions"?"Next Up":activeView?.label}</h1>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div className="topbar-date">{todayStr}</div>
            <button
              onClick={signOut}
              title={`Sign out (${session?.user?.email || "signed in"})`}
              style={{background:"none",border:"1px solid var(--border2)",color:"var(--muted)",padding:"4px 10px",borderRadius:4,fontFamily:"var(--font-mono)",fontSize:10,letterSpacing:"0.08em",textTransform:"uppercase",cursor:"pointer"}}>
              Sign out
            </button>
          </div>
        </div>
        <div className="content">
          {(urgent.length>0||urgentExams.length>0)&&state.view==="plan"&&(
            <div className="urgent-banner"><span>⚠️</span><div>
              <strong>URGENT</strong> —{" "}
              {urgentExams.map((e,i)=><span key={e.id} style={{color:"#6d3fa0"}}>EXAM: {e.title}{i<urgentExams.length-1?", ":""}</span>)}
              {urgent.length>0&&urgentExams.length>0&&", "}
              {urgent.map((a,i)=><span key={a.id}>{a.title}{i<urgent.length-1?", ":""}</span>)}
            </div></div>
          )}
          {state.view==="plan"   &&<PlanView    state={state} dispatch={dispatch} showFlash={showFlash} onAddAsgn={()=>setShowAddAsgn(true)} onAddExam={()=>setShowAddExam(true)} onAddCourse={()=>setShowAddCourse(true)} onEditCourse={(c)=>setEditingCourse(c)}/>}
          {state.view==="actions" &&<ActionsView state={state} dispatch={dispatch} showFlash={showFlash}/>}
          {state.view==="grades"  &&<GradesView  state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
          {state.view==="timer"   &&<TimerView   state={state} dispatch={dispatch} session={session} showFlash={showFlash} onTimerComplete={(payload)=>setPendingSession(payload)}/>}
          {state.view==="log"     &&<SessionsView state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
          {state.view==="settings"&&<SettingsView state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
        </div>
      </main>

      {/* ── Mobile: collapsible course strip + bottom tab bar ── */}
      <nav className="mobile-tabbar">
        {views.map(v=><div key={v.id} role="button" tabIndex={0} className={"mobile-tab"+(state.view===v.id?" active":"")}
          onClick={()=>dispatch({type:"SET_VIEW",view:v.id})}
          onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:v.id})}>
          <span className="mobile-tab-icon">{v.icon}</span>{v.label}
        </div>)}
      </nav>
      </div>
    )}

    {/* ── Modals ── */}
    {showAddCourse&&<div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add a Course" onClick={()=>setShowAddCourse(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-title">Add a Course</div>
      <div className="input-group"><div className="input-label">Course name</div><input type="text" placeholder="e.g. Calculus II" value={newCourseName} onChange={e=>setNewCourseName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCourse()} autoFocus/></div>
      <div style={{display:"flex",gap:8,marginBottom:16}}>{COURSE_COLORS.map((c,i)=><div key={c} onClick={()=>setColorIdx(i)} style={{width:20,height:20,borderRadius:"50%",background:c,cursor:"pointer",outline:colorIdx===i?"2px solid "+c:"none",outlineOffset:2}}/>)}</div>
      <div style={{display:"flex",gap:8}}><button className="btn" onClick={addCourse}>Add Course</button><button className="btn-outline" onClick={()=>setShowAddCourse(false)}>Cancel</button></div>
    </div></div>}
    {showAddAsgn&&<AddAsgnModal courses={courses} activeCourse={state.activeCourse} onAdd={(data)=>{dispatch({type:"ADD_ASSIGNMENT",title:data.title,courseId:data.courseId,assignType:data.type,dueDate:data.dueDate,notes:data.notes});setShowAddAsgn(false);showFlash("Assignment added");}} onClose={()=>setShowAddAsgn(false)}/>}
    {showAddExam&&<AddExamModal courses={courses} activeCourse={state.activeCourse} onAdd={(data)=>{dispatch({type:"ADD_EXAM",...data});setShowAddExam(false);showFlash("Exam added");}} onClose={()=>setShowAddExam(false)}/>}
    {editingCourse&&<EditCourseModal
      course={state.courses[editingCourse.id] || editingCourse}
      onSave={(name,color,credits,semester)=>{
        dispatch({type:"EDIT_COURSE",id:editingCourse.id,name,color,credits,semester});
        setEditingCourse(null); showFlash("Course updated");
        if (session) sync.upsertSubject({ id:editingCourse.id, name, credits, semester, color }).catch(e=>showFlash("Sync failed: "+e.message));
      }}
      onDelete={()=>{
        const id=editingCourse.id;
        dispatch({type:"DELETE_COURSE",id});
        setEditingCourse(null); showFlash("Course deleted");
        if (session) sync.deleteSubject(id).catch(e=>showFlash("Sync failed: "+e.message));
      }}
      onClose={()=>setEditingCourse(null)}/>}
    {pendingSession && (
      <SaveSessionSheet
        pending={pendingSession}
        courses={courses}
        onClose={()=>setPendingSession(null)}
        onSave={async ({subjectId, durationMinutes, notes, startedAt}) => {
          const id = newSyncId();
          dispatch({type:"ADD_SESSION", id, subjectId: subjectId||null, startedAt, durationMinutes, notes});
          setPendingSession(null);
          showFlash(`Logged ${durationMinutes}m`);
          if (session) {
            sync.logStudySession({id, subjectId, startedAt, durationMinutes, notes})
              .catch(e=>showFlash("Sync failed: "+e.message));
          }
        }}
      />
    )}
    {flash&&<div className="flash">{flash}</div>}
  </>);
}

// ── OnboardingView — 3-step first-run wizard ──────────────────────────────────
function OnboardingView({ onComplete }) {
  const [step, setStep] = useState(0); // 0=welcome, 1=add course, 2=notification ask
  const [courseName, setCourseName] = useState("");
  const [colorIdx, setColorIdx] = useState(0);

  const chosenColor = COURSE_COLORS[colorIdx % COURSE_COLORS.length];

  const stepDots = [0,1,2].map(i => (
    <div key={i} className={"ob-step-dot"+(i===step?" active":i<step?" done":"")}/>
  ));

  if (step === 0) return (
    <div className="ob-wrap">
      <div className="ob-card">
        <div className="ob-wordmark">Studydesk</div>
        <div className="ob-tagline">STOP DECIDING. START STUDYING.</div>
        <div className="ob-steps">{stepDots}</div>
        <div className="ob-step-title">Know what to do next,<br/>every time you sit down.</div>
        <div className="ob-step-desc">
          Tell Studydesk what's due. It tells you what to work on right now — no decision cost, no anxiety.
        </div>
        <button className="btn" style={{width:"100%",padding:"13px"}} onClick={()=>setStep(1)}>
          Get started →
        </button>
      </div>
    </div>
  );

  if (step === 1) return (
    <div className="ob-wrap">
      <div className="ob-card">
        <div className="ob-wordmark">Studydesk</div>
        <div className="ob-tagline">STEP 1 OF 2</div>
        <div className="ob-steps">{stepDots}</div>
        <div className="ob-step-title">Add your first course</div>
        <div className="ob-step-desc">What are you studying right now? You can add more courses later.</div>
        <div className="input-group">
          <div className="input-label">Course name</div>
          <input type="text" placeholder="e.g. Calculus II, History, Biology…"
            value={courseName} onChange={e=>setCourseName(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&courseName.trim()&&setStep(2)}
            autoFocus/>
        </div>
        <div className="input-group">
          <div className="input-label">Pick a colour</div>
          <div className="ob-colors">
            {COURSE_COLORS.map((c,i)=>(
              <div key={c} className="ob-color"
                style={{background:c, outline:colorIdx===i?"3px solid "+c:"2px solid transparent", outlineOffset:2}}
                onClick={()=>setColorIdx(i)}/>
            ))}
          </div>
        </div>
        <button className="btn" style={{width:"100%",padding:"13px",marginTop:8}}
          onClick={()=>{ if(courseName.trim()) setStep(2); }}>
          Continue →
        </button>
        <div className="ob-skip" onClick={()=>setStep(2)}>Skip for now</div>
      </div>
    </div>
  );

  if (step === 2) return (
    <div className="ob-wrap">
      <div className="ob-card">
        <div className="ob-wordmark">Studydesk</div>
        <div className="ob-tagline">ONE LAST THING</div>
        <div className="ob-steps">{stepDots}</div>
        <div className="ob-notif-box">
          <div className="ob-notif-icon">🔔</div>
          <div className="ob-notif-title">Daily reminders</div>
          <div className="ob-notif-desc">
            Studydesk can nudge you each morning with your top study priority. No noise — just one useful prompt.
          </div>
        </div>
        <button className="btn" style={{width:"100%",padding:"13px",marginBottom:10}}
          onClick={()=>onComplete(courseName.trim()?{name:courseName.trim(),color:chosenColor}:null)}>
          Enable reminders
        </button>
        <button className="btn-outline" style={{width:"100%",padding:"11px"}}
          onClick={()=>onComplete(courseName.trim()?{name:courseName.trim(),color:chosenColor}:null)}>
          Maybe later
        </button>
      </div>
    </div>
  );

  return null;
}

// ── Pomodoro Timer ────────────────────────────────────────────────────────────
function TimerView({ state, onTimerComplete }) {
  const FOCUS_SECS = 25*60, SHORT_SECS = 5*60, LONG_SECS = 15*60;

  // Restore persisted timer state from localStorage so tab-switching doesn't reset
  const _saved = (() => { try { return JSON.parse(localStorage.getItem('sd-timer')||'{}'); } catch { return {}; } })();

  const [customFocus, setCustomFocus] = useState(_saved.customFocus||25);
  const [phase, setPhase] = useState(_saved.phase||"focus"); // focus | short | long
  // If timer was running when user left, compute corrected secsLeft
  const _initSecs = (() => {
    if (_saved.running && _saved.startedAt && _saved.secsAtStart) {
      const elapsed = Math.floor((Date.now() - _saved.startedAt) / 1000);
      const corrected = _saved.secsAtStart - elapsed;
      return corrected > 0 ? corrected : 0;
    }
    return _saved.secsLeft || FOCUS_SECS;
  })();
  const [secsLeft, setSecsLeft] = useState(_initSecs);
  // If timer ran out while away, don't auto-resume
  const [running, setRunning] = useState(_saved.running && _initSecs > 0 ? true : false);
  const [session, setSession] = useState(_saved.session||0); // 0-3, cycles every 4
  const [focusDone, setFocusDone] = useState(_saved.focusDone||0); // total focus sessions today
  const [task, setTask] = useState(_saved.task||"");
  const [timerDone, setTimerDone] = useState(false);
  // Lock In: a no-break, no-nav, no-distraction focus mode. Persists
  // across tab switches so coming back to Timer keeps you in flow.
  const [lockedIn, setLockedIn] = useState(_saved.lockedIn || false);
  // Track when the current focus phase started, so SaveSessionSheet
  // can write an accurate `started_at` timestamp to Supabase.
  const phaseStartedAtRef = useRef(_saved.phaseStartedAt || null);
  const intervalRef = useRef(null);
  const phaseRef = useRef(phase);
  const sessionRef = useRef(session);
  const focusDoneRef = useRef(focusDone);
  const taskRef = useRef(task);
  const customFocusRef = useRef(customFocus);
  useEffect(()=>{ phaseRef.current=phase; },[phase]);
  useEffect(()=>{ sessionRef.current=session; },[session]);
  useEffect(()=>{ focusDoneRef.current=focusDone; },[focusDone]);
  useEffect(()=>{ taskRef.current=task; },[task]);
  useEffect(()=>{ customFocusRef.current=customFocus; },[customFocus]);

  // Persist timer state to localStorage so tab-switching preserves it
  useEffect(() => {
    try {
      localStorage.setItem('sd-timer', JSON.stringify({
        customFocus, phase, secsLeft, running, session, focusDone, task, lockedIn,
        startedAt: startedAtRef.current,
        secsAtStart: secsAtStartRef.current,
        phaseStartedAt: phaseStartedAtRef.current,
      }));
    } catch {}
  }, [customFocus, phase, secsLeft, running, session, focusDone, task, lockedIn]);

  // Background-safe elapsed tracking refs
  const startedAtRef = useRef(null);
  const secsAtStartRef = useRef(null);

  // Vibration + beep on phase end
  const fireCompletionAlert = useCallback(() => {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = (freq, start, dur) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = 'sine';
        gain.gain.setValueAtTime(0.35, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + dur + 0.05);
      };
      beep(880, 0, 0.18); beep(880, 0.25, 0.18); beep(1100, 0.5, 0.35);
    } catch(_) {}
  }, []);

  const lockedInRef = useRef(lockedIn);
  useEffect(()=>{ lockedInRef.current = lockedIn; }, [lockedIn]);

  const handlePhaseEnd = useCallback(() => {
    clearInterval(intervalRef.current);
    startedAtRef.current = null;
    setRunning(false);
    setTimerDone(true);
    setTimeout(()=>setTimerDone(false), 1500);
    fireCompletionAlert();
    const p=phaseRef.current, sess=sessionRef.current, fd=focusDoneRef.current, cf=customFocusRef.current;
    if (p==='focus') {
      setFocusDone(fd+1);
      // Raise the SaveSessionSheet — user explicitly opts in to logging.
      const startedAtIso = phaseStartedAtRef.current
        ? new Date(phaseStartedAtRef.current).toISOString()
        : new Date(Date.now() - cf*60*1000).toISOString();
      onTimerComplete?.({
        durationMinutes: cf,
        task: taskRef.current,
        startedAt: startedAtIso,
      });
      phaseStartedAtRef.current = null;
      // Lock In skips break cycling — stays on focus, ready for the next block.
      // Regular Pomodoro cycles short / long breaks every 4 focus sessions.
      if (lockedInRef.current) {
        setPhase('focus');
        setSecsLeft(cf*60);
      } else {
        const nextSession=(sess+1)%4;
        setSession(nextSession);
        const nextPhase=nextSession===0?'long':'short';
        setPhase(nextPhase);
        setSecsLeft(nextPhase==='long'?LONG_SECS:SHORT_SECS);
      }
    } else {
      setPhase('focus');
      setSecsLeft(cf*60);
    }
  }, [fireCompletionAlert, onTimerComplete]);

  const tick = useCallback(() => {
    setSecsLeft(s => { if (s <= 1) { handlePhaseEnd(); return 0; } return s - 1; });
  }, [handlePhaseEnd]);

  // Background correction: recalculate elapsed on app resume
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && running && startedAtRef.current !== null) {
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
        const corrected = (secsAtStartRef.current || 0) - elapsed;
        if (corrected <= 0) { handlePhaseEnd(); }
        else {
          setSecsLeft(corrected);
          startedAtRef.current = Date.now();
          secsAtStartRef.current = corrected;
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [running, handlePhaseEnd]);

  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
  const totalSecs = phase==="focus" ? customFocus*60 : phase==="short" ? SHORT_SECS : LONG_SECS;
  const pct = secsLeft / totalSecs;
  const R = 100, CIRC = 2*Math.PI*R;
  const phaseColor = phase==="focus" ? "#1a1814" : phase==="short" ? "#2e7d52" : "#1a5c9e";

  useEffect(() => {
    if (running) {
      startedAtRef.current = Date.now();
      secsAtStartRef.current = secsLeft;
      // The actual 1s tick — without this the timer doesn't advance.
      intervalRef.current = setInterval(tick, 1000);
      // Capture the phase start so onTimerComplete can report an accurate started_at.
      // For focus phases, only set this if we're actually beginning a fresh phase
      // (not resuming from a pause mid-phase). Approximation: if secsLeft equals
      // the full duration, treat as a fresh start.
      if (phaseRef.current === 'focus' && secsLeft === customFocusRef.current*60) {
        phaseStartedAtRef.current = Date.now();
      } else if (phaseRef.current === 'focus' && phaseStartedAtRef.current == null) {
        // Resuming a paused focus that never had a start recorded — back-compute.
        phaseStartedAtRef.current = Date.now() - (customFocusRef.current*60 - secsLeft) * 1000;
      }
    } else {
      clearInterval(intervalRef.current);
      startedAtRef.current = null;
    }
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, tick]);

  const toggle = () => setRunning(r=>!r);
  const reset = () => { setRunning(false); setSecsLeft(phase==="focus"?customFocus*60:phase==="short"?SHORT_SECS:LONG_SECS); };
  const skip = () => {
    setRunning(false);
    if (phase==="focus") { const np=(session+1)%4===0?"long":"short"; setPhase(np); setSecsLeft(np==="long"?LONG_SECS:SHORT_SECS); setSession(s=>(s+1)%4); }
    else { setPhase("focus"); setSecsLeft(customFocus*60); }
  };
  const changeCustom = (v) => { if(!running){ setCustomFocus(v); if(phase==="focus") setSecsLeft(v*60); } };

  // Toggle Lock In: force a clean focus phase, hide nav, no breaks.
  // Exiting Lock In stops the timer cleanly so the user explicitly chooses
  // whether to keep going in regular mode.
  const toggleLockIn = () => {
    setLockedIn(li => {
      const next = !li;
      if (next) {
        // Entering Lock In — reset to a fresh focus block at current custom duration.
        setPhase("focus");
        setSecsLeft(customFocus * 60);
        setSession(0);
      } else {
        // Exiting Lock In — stop and let the user reorient.
        setRunning(false);
      }
      return next;
    });
  };

  // While locked in we add a body class so the bottom mobile tab bar and
  // desktop sidebar can hide via CSS. Cleans up on unmount / toggle-off.
  useEffect(() => {
    if (lockedIn) document.body.classList.add('locked-in');
    else document.body.classList.remove('locked-in');
    return () => document.body.classList.remove('locked-in');
  }, [lockedIn]);

  // ── Lock In takeover view ───────────────────────────────────────────────
  if (lockedIn) {
    return <div className="lockin-wrap">
      <div className="lockin-top">
        <span className="lockin-badge">LOCK IN</span>
        <span className="lockin-task">{task || "Deep focus"}</span>
      </div>
      <div className={"pomo-ring-wrap lockin-ring"+(timerDone?" pomo-ring-done":"")}>
        <svg className="pomo-ring-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">
          <circle cx="110" cy="110" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6"/>
          <circle cx="110" cy="110" r={R} fill="none"
            stroke="#faf8f4" strokeWidth="6" strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC*(1-pct)}
            transform="rotate(-90 110 110)"/>
        </svg>
        <div className="pomo-ring-label">
          <div className={"pomo-time"+(timerDone?" pomo-time-flash":"")} style={{color:"#faf8f4"}}>{fmtMMSS(secsLeft)}</div>
          <div className="pomo-phase" style={{color:"rgba(250,248,244,0.5)"}}>FOCUS · {focusDone} done</div>
        </div>
      </div>
      <input
        type="text"
        className="lockin-task-input"
        placeholder="What are you locking in on?"
        value={task}
        onChange={e=>setTask(e.target.value)}
      />
      <div className="lockin-controls">
        <button className="lockin-btn-main" onClick={toggle} aria-label={running?"Pause":"Start"}>
          {running
            ? <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>
            : <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><polygon points="6,3 20,12 6,21"/></svg>
          }
        </button>
      </div>
      <div className="lockin-presets">
        {[25,45,60,90].map(m=><button key={m} className={"lockin-preset"+(customFocus===m?" active":"")} onClick={()=>changeCustom(m)} disabled={running}>{m}m</button>)}
      </div>
      <button className="lockin-exit" onClick={toggleLockIn}>End session</button>
    </div>;
  }

  return <div style={{display:"flex",flexDirection:"column",alignItems:"center",paddingTop:24,paddingBottom:32}}>
    <div className={"pomo-ring-wrap"+(timerDone?" pomo-ring-done":"")}>
      <svg className="pomo-ring-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">
        <circle cx="110" cy="110" r={R} fill="none" stroke="var(--border)" strokeWidth="8"/>
        <circle cx="110" cy="110" r={R} fill="none"
          stroke={phaseColor} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC*(1-pct)}
          transform="rotate(-90 110 110)"/>
      </svg>
      <div className="pomo-ring-label">
        <div className={"pomo-time"+(timerDone?" pomo-time-flash":"")} style={{color:phaseColor}}>{fmtMMSS(secsLeft)}</div>
        <div className="pomo-phase">{phase==="focus"?"FOCUS":phase==="short"?"SHORT BREAK":"LONG BREAK"}</div>
      </div>
    </div>
    <div className="pomo-segments">
      {[0,1,2,3].map(i=><div key={i} className={"pomo-seg"+(i<focusDone%4?"done":i===session&&phase==="focus"?"current":"")}/>)}
    </div>
    <div className="pomo-controls">
      <button className="pomo-btn-sec" onClick={reset} title="Reset">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3.3-6.7"/><polyline points="3 3 3 8 8 8"/></svg>
      </button>
      <button className={"pomo-btn-main"+(!running && secsLeft < totalSecs?" paused":"")} onClick={toggle}>
        {running
          ? <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>
          : <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><polygon points="6,3 20,12 6,21"/></svg>
        }
      </button>
      <button className="pomo-btn-sec" onClick={skip} title="Skip">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><polygon points="5,4 15,12 5,20"/><rect x="17" y="4" width="3" height="16" rx="1"/></svg>
      </button>
    </div>
    {phase==="focus"&&<div className="pomo-presets">
      {[15,20,25,30,45,60].map(m=><button key={m} className={"pomo-preset-btn"+(customFocus===m?" active":"")} onClick={()=>changeCustom(m)}>{m}m</button>)}
    </div>}
    <button className="lockin-enter" onClick={toggleLockIn} title="Strip breaks, hide nav, deep focus only">
      🔒 Lock in
    </button>
    <div className="pomo-task-row">
      <div className="pomo-task-label">Studying</div>
      <input type="text" placeholder="What are you working on? (optional)" value={task} onChange={e=>setTask(e.target.value)} style={{fontSize:14,padding:"10px 12px"}}/>
      {courses.length>0&&<select aria-label="Quick fill from course" value="" onChange={e=>setTask(e.target.value)} style={{marginTop:6}}>
        <option value="">Quick fill from course…</option>
        {courses.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}
      </select>}
    </div>
    {(()=>{
      const sessions = (state.studySessions||[]).filter(s=>!s.deletedAt);
      if (sessions.length === 0) return null;
      const today = new Date().toISOString().slice(0,10);
      const dateKey = (iso) => iso ? iso.slice(0,10) : null;
      const todayList = sessions
        .filter(s => dateKey(s.startedAt) === today)
        .sort((a,b)=> (b.startedAt||"").localeCompare(a.startedAt||""));
      // Weekly summary: group by ISO Monday-week
      const getWeekKey = (iso) => {
        if(!iso) return null;
        const d = new Date(iso); if (isNaN(d.getTime())) return null;
        const day = d.getDay(); const diff = d.getDate() - day + (day===0?-6:1);
        const mon = new Date(d); mon.setDate(diff);
        return mon.toISOString().slice(0,10);
      };
      const weekMap = {};
      sessions.forEach(s => {
        const wk = getWeekKey(s.startedAt); if(!wk) return;
        weekMap[wk] = (weekMap[wk]||0) + (Number(s.durationMinutes)||0);
      });
      const weeks = Object.entries(weekMap).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,8);
      const thisWeekKey = getWeekKey(new Date().toISOString());
      return <div className="pomo-session-log">
        <div className="section-label" style={{marginTop:24}}>Weekly hours</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
          {weeks.map(([wk,mins])=>{
            const hrs = (mins/60).toFixed(1);
            const label = wk===thisWeekKey?"This week":("Wk "+wk.slice(5));
            const barH = Math.max(4, Math.round((mins/600)*48));
            return <div key={wk} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,minWidth:44}}>
              <span style={{fontFamily:"var(--font-mono)",fontSize:9,color:"var(--muted2)"}}>{hrs}h</span>
              <div style={{width:28,height:barH,background:wk===thisWeekKey?"var(--text)":"var(--border2)",borderRadius:2,alignSelf:"flex-end"}}/>
              <span style={{fontFamily:"var(--font-mono)",fontSize:8,color:"var(--muted2)",textAlign:"center"}}>{label}</span>
            </div>;
          })}
        </div>
        {todayList.length>0 && <>
          <div className="section-label">Today's sessions</div>
          {todayList.map(s=>{
            const c = s.subjectId ? state.courses[s.subjectId] : null;
            const ts = s.startedAt ? new Date(s.startedAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : "";
            return <div key={s.id} className="pomo-log-entry">
              <span className="pomo-log-badge">{ts}</span>
              <span>{c?.name || s.notes || "—"}</span>
              <span style={{marginLeft:"auto",fontFamily:"var(--font-mono)",fontSize:10,color:"var(--muted2)"}}>{s.durationMinutes}m</span>
            </div>;
          })}
        </>}
      </div>;
    })()}
  </div>;
}

function StatusView({ state, dispatch, showFlash, onAddAsgn }) {
  const courses=Object.values(state.courses); const ac=state.activeCourse;
  const assignments=ac?state.assignments.filter(a=>a.courseId===ac):state.assignments;
  const open=assignments.filter(a=>!a.done); const done=assignments.filter(a=>a.done);
  return <div>
    <div className="section-label">Deadlines{ac&&" · "+(state.courses[ac]?.name||"")}</div>
    {open.length===0&&courses.length>0&&<div className="empty">No open assignments.</div>}
    {open.slice().sort((a,b)=>new Date(a.dueDate||"9999-12-31")-new Date(b.dueDate||"9999-12-31")).map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch}/>)}
    <div style={{marginTop:12,marginBottom:24}}><button className="btn-outline" onClick={onAddAsgn}>+ Add Assignment</button></div>
    {done.length>0&&<><div className="divider"/><div className="section-label">Completed ({done.length})</div>{done.slice().sort((a,b)=>new Date(b.dueDate||"1970-01-01")-new Date(a.dueDate||"1970-01-01")).map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch}/>)}</>}
  </div>;
}

function AsgnItem({ asgn, courses, dispatch }) {
  const course=courses[asgn.courseId]; const days=daysUntil(asgn.dueDate);
  const [editing,setEditing]=useState(false);
  const [editTitle,setEditTitle]=useState(asgn.title);
  const [editDate,setEditDate]=useState(asgn.dueDate||"");
  const [editNotes,setEditNotes]=useState(asgn.notes||"");
  const save=()=>{ dispatch({type:"EDIT_ASSIGNMENT",id:asgn.id,title:editTitle.trim()||asgn.title,dueDate:editDate,notes:editNotes}); setEditing(false); };
  if(editing) return <div className="asgn-item" style={{flexDirection:"column",gap:10}}>
    <input type="text" value={editTitle} onChange={e=>setEditTitle(e.target.value)} style={{fontWeight:500}} autoFocus/>
    <input type="date" value={editDate} onChange={e=>setEditDate(e.target.value)}/>
    <textarea value={editNotes} onChange={e=>setEditNotes(e.target.value)} placeholder="Notes…" style={{minHeight:48,fontSize:12}}/>
    <div style={{display:"flex",gap:8}}><button className="btn btn-sm" onClick={save}>Save</button><button className="btn-outline btn-sm" onClick={()=>setEditing(false)}>Cancel</button></div>
  </div>;
  return <div className={"asgn-item"+(asgn.done?" done":"")}>
    <div className={"asgn-check"+(asgn.done?" checked":"")} onClick={()=>dispatch({type:"TOGGLE_ASSIGNMENT",id:asgn.id})}/>
    <div className="asgn-body">
      <div className={"asgn-title"+(asgn.done?" done":"")}>{asgn.title}</div>
      <div className="asgn-meta">
        {course&&<span className="asgn-course" style={{background:course.color+"18",color:course.color}}>{course.name}</span>}
        {asgn.type&&<span className="asgn-type">{asgn.type}</span>}
        {asgn.dueDate&&<span className="asgn-due" style={{color:asgn.done?"var(--muted2)":urgencyColor(days)}}>{fmtDate(asgn.dueDate)} · {urgencyLabel(days)}</span>}
      </div>
      {asgn.notes&&<div className="asgn-notes">{asgn.notes}</div>}
    </div>
    <button className="btn-danger-text" style={{fontSize:13,color:"var(--muted2)"}} onClick={()=>setEditing(true)} title="Edit">✎</button>
    <button className="btn-danger-text" onClick={()=>dispatch({type:"DELETE_ASSIGNMENT",id:asgn.id})}>×</button>
  </div>;
}

function AddAsgnModal({ courses, activeCourse, onAdd, onClose }) {
  const [title,setTitle]=useState(""); const [courseId,setCourse]=useState(activeCourse||(courses[0]?.id??"")); const [type,setType]=useState(ASSIGN_TYPES[0]); const [dueDate,setDueDate]=useState(""); const [notes,setNotes]=useState("");
  const submit=()=>{ if(!title.trim()||!courseId) return; onAdd({title:title.trim(),courseId,type,dueDate,notes}); };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add Assignment" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
    <div className="modal-title">Add Assignment</div>
    <div className="input-group"><div className="input-label">Title</div><input type="text" placeholder="e.g. Problem Set 3" value={title} onChange={e=>setTitle(e.target.value)} autoFocus/></div>
    <div className="modal-grid">
      <div className="input-group"><div className="input-label">Course</div><select value={courseId} onChange={e=>setCourse(e.target.value)}>{courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="input-group"><div className="input-label">Type</div><select value={type} onChange={e=>setType(e.target.value)}>{ASSIGN_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
    </div>
    <div className="input-group"><div className="input-label">Due Date (optional)</div><input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></div>
    <div className="input-group"><div className="input-label">Notes (optional)</div><textarea placeholder="Details, links, what to focus on..." value={notes} onChange={e=>setNotes(e.target.value)} style={{minHeight:60}}/></div>
    <div style={{display:"flex",gap:8,marginTop:4}}><button className="btn" onClick={submit}>Add Assignment</button><button className="btn-outline" onClick={onClose}>Cancel</button></div>
  </div></div>;
}

function AddExamModal({ courses, activeCourse, onAdd, onClose }) {
  const [title,setTitle]=useState(""); const [courseId,setCourse]=useState(activeCourse||(courses[0]?.id??"")); const [dueDate,setDueDate]=useState(""); const [difficulty,setDiff]=useState("medium"); const [notes,setNotes]=useState("");
  const submit=()=>{ if(!title.trim()||!courseId||!dueDate) return; onAdd({title:title.trim(),courseId,dueDate,difficulty,notes}); };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add Assignment" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
    <div className="modal-title">Add Exam</div>
    <div className="input-group"><div className="input-label">Exam / Subject</div><input type="text" placeholder="e.g. Calculus II Midterm" value={title} onChange={e=>setTitle(e.target.value)} autoFocus/></div>
    <div className="modal-grid">
      <div className="input-group"><div className="input-label">Course</div><select value={courseId} onChange={e=>setCourse(e.target.value)}>{courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="input-group"><div className="input-label">Exam Date</div><input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></div>
    </div>
    <div className="input-group"><div className="input-label">Difficulty</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {["easy","medium","hard","brutal"].map(d=>(
          <span key={d} className="difficulty-pill" style={{background:difficulty===d?DIFFICULTY_COLORS[d]+"18":"transparent",color:difficulty===d?DIFFICULTY_COLORS[d]:"var(--muted2)",borderColor:difficulty===d?DIFFICULTY_COLORS[d]:"var(--border2)",padding:"6px 14px",fontSize:12}} onClick={()=>setDiff(d)}>
            {DIFFICULTY_LABELS[d]} <span style={{opacity:0.6,fontSize:10}}>({DIFFICULTY_DAYS[d]}d)</span>
          </span>
        ))}
      </div>
    </div>
    {dueDate&&<div style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",marginBottom:12,padding:"8px 12px",background:"var(--surface2)",borderRadius:4}}>
      📚 Study start: <strong>{fmtDateFull(addDays(dueDate,-DIFFICULTY_DAYS[difficulty]))}</strong>
    </div>}
    <div className="input-group"><div className="input-label">Notes (optional)</div><textarea placeholder="Topics covered, format, what to focus on..." value={notes} onChange={e=>setNotes(e.target.value)} style={{minHeight:60}}/></div>
    <div style={{display:"flex",gap:8,marginTop:4}}><button className="btn" onClick={submit}>Add Exam</button><button className="btn-outline" onClick={onClose}>Cancel</button></div>
  </div></div>;
}

function EditCourseModal({ course, onSave, onDelete, onClose }) {
  const [name,setName]=useState(course.name);
  const [color,setColor]=useState(course.color);
  const [credits,setCredits]=useState(course.credits!=null?String(course.credits):"1");
  const [semester,setSemester]=useState(course.semester||"");
  const [confirmDelete,setConfirmDelete]=useState(false);
  const doSave = () => {
    if(!name.trim()) return;
    const cr = parseFloat(credits);
    onSave(name.trim(), color, isNaN(cr)?1:cr, semester.trim()||null);
  };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Edit Course" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
    <div className="modal-title">Edit Course</div>
    <div className="input-group"><div className="input-label">Course name</div><input type="text" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSave()} autoFocus/></div>
    <div className="modal-grid">
      <div className="input-group"><div className="input-label">Credits (GPA weight)</div><input type="number" step="0.5" min="0" value={credits} onChange={e=>setCredits(e.target.value)}/></div>
      <div className="input-group"><div className="input-label">Semester</div><input type="text" placeholder="e.g. Spring 2026" value={semester} onChange={e=>setSemester(e.target.value)}/></div>
    </div>
    <div className="input-group"><div className="input-label">Color</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{COURSE_COLORS.map(c=><div key={c} onClick={()=>setColor(c)} style={{width:24,height:24,borderRadius:"50%",background:c,cursor:"pointer",outline:color===c?"3px solid "+c:"2px solid transparent",outlineOffset:2}}/>)}</div>
    </div>
    <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center"}}>
      <button className="btn" onClick={doSave}>Save</button>
      <button className="btn-outline" onClick={onClose}>Cancel</button>
      <span style={{flex:1}}/>
      {!confirmDelete
        ?<button className="btn-outline" style={{color:"#c0392b",borderColor:"#c0392b"}} onClick={()=>setConfirmDelete(true)}>Delete course</button>
        :<div style={{display:"flex",gap:8,alignItems:"center"}}>
          <span style={{fontFamily:"var(--font-mono)",fontSize:11,color:"#c0392b"}}>Delete all data?</span>
          <button className="btn-red" onClick={onDelete}>Yes, delete</button>
          <button className="btn-outline" onClick={()=>setConfirmDelete(false)}>No</button>
        </div>}
    </div>
  </div></div>;
}

// ── PlanView — unified planning surface (assignments + exams + courses) ────────
function PlanView({ state, dispatch, showFlash, onAddAsgn, onAddExam, onAddCourse, onEditCourse }) {
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
  const dayIsToday=(date)=>toLocalISO(date)===toLocalISO(TODAY);
  const monthName=firstDay.toLocaleDateString("en-GB",{month:"long",year:"numeric"});
  const prevMonth=()=>setCalMonth(m=>m.month===0?{year:m.year-1,month:11}:{year:m.year,month:m.month-1});
  const nextMonth=()=>setCalMonth(m=>m.month===11?{year:m.year+1,month:0}:{year:m.year,month:m.month+1});
  const agendaEvents=[];
  for(let i=0;i<60;i++){const d=new Date(TODAY);d.setDate(TODAY.getDate()+i);const ev=eventsOnDay(d);if(ev.length>0)agendaEvents.push({date:d,events:ev});}
  const openAsgns=state.assignments.filter(a=>!a.done).sort((a,b)=>new Date(a.dueDate||"9999-12-31")-new Date(b.dueDate||"9999-12-31"));
  const openExams=state.exams.filter(e=>!e.done).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
  return <div>
    <div className="section-label">Assignments<button className="btn btn-sm" style={{marginLeft:"auto"}} onClick={onAddAsgn}>+ Add</button></div>
    {openAsgns.length===0&&<div className="empty">No open assignments.</div>}
    {openAsgns.map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch}/>)}
    {state.assignments.filter(a=>a.done).length>0&&<details style={{marginBottom:16}}><summary style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",cursor:"pointer",padding:"8px 0"}}>Completed ({state.assignments.filter(a=>a.done).length})</summary>{state.assignments.filter(a=>a.done).sort((a,b)=>new Date(b.dueDate||"1970-01-01")-new Date(a.dueDate||"1970-01-01")).map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch}/>)}</details>}
    <div className="divider"/>
    <div className="section-label">Exams &amp; Calendar<button className="btn btn-sm" style={{marginLeft:"auto"}} onClick={onAddExam}>+ Add</button></div>
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
      <button className="btn-outline btn-sm" onClick={prevMonth}>←</button>
      <span style={{fontFamily:"var(--font-display)",fontSize:16,flex:1}}>{monthName}</span>
      <button className="btn-outline btn-sm" onClick={nextMonth}>→</button>
    </div>
    <div className="calendar-grid cal-header-row" style={{marginBottom:0,gap:4}}>{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=><div key={d} className="cal-header">{d}</div>)}</div>
    <div className="calendar-grid" style={{marginBottom:16}}>
      {days.map((day,i)=>{const events=eventsOnDay(day.date);return <div key={i} className={"cal-day"+(dayIsToday(day.date)?" today":"")+(day.current?"":" other-month")}><div className="cal-day-num">{day.date.getDate()}</div>{events.map((ev,j)=>{if(ev.type==="exam") return <div key={j} className="cal-event cal-exam" title={"EXAM: "+ev.exam.title}>📝 {ev.exam.title}</div>;if(ev.type==="study") return <div key={j} className="cal-event cal-study" title={"Study: "+ev.exam.title}>📚 {ev.exam.title}</div>;const col=ev.course?.color||"#8a8278";return <div key={j} className="cal-event" style={{background:col+"22",color:col}} title={ev.asgn.title}>◷ {ev.asgn.title}</div>;})}</div>;})}
    </div>
    <div className="cal-agenda" style={{marginBottom:16}}>
      {agendaEvents.length===0&&<div className="empty">Nothing coming up.</div>}
      {agendaEvents.map((entry,i)=>{const label=entry.date.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});return <div key={i} className="cal-agenda-item"><div className="cal-agenda-date">{label}</div><div className="cal-agenda-pills">{entry.events.map((ev,j)=>{if(ev.type==="exam"||ev.type==="study"){const c=ev.course;return <div key={j} className="cal-agenda-pill" style={{background:ev.type==="exam"?"rgba(109,63,160,0.10)":"rgba(26,92,158,0.08)"}}><span>{ev.type==="exam"?"📝":"📚"}</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,color:ev.type==="exam"?"#6d3fa0":"#1a5c9e"}}>{ev.type==="exam"?"EXAM":"STUDY"}</span><span style={{fontSize:13}}>{ev.exam.title}</span>{c&&<span className="asgn-course" style={{background:c.color+"18",color:c.color}}>{c.name}</span>}</div>;}const c=ev.course;return <div key={j} className="cal-agenda-pill" style={{background:c?c.color+"18":"var(--surface2)"}}><span>◷</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,color:c?.color||"var(--muted)"}}>DUE</span><span style={{fontSize:13}}>{ev.asgn.title}</span>{c&&<span className="asgn-course" style={{background:c.color+"18",color:c.color}}>{c.name}</span>}</div>;})}</div></div>;})}
    </div>
    {openExams.map(e=><ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch}/>)}
    {openExams.length===0&&<div className="empty">No exams yet.</div>}
    {state.exams.filter(e=>e.done).length>0&&<details style={{marginBottom:16}}><summary style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",cursor:"pointer",padding:"8px 0"}}>Completed exams ({state.exams.filter(e=>e.done).length})</summary>{state.exams.filter(e=>e.done).map(e=><ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch}/>)}</details>}
    <div className="divider"/>
    <div className="section-label">Courses<button className="btn btn-sm" style={{marginLeft:"auto"}} onClick={onAddCourse}>+ Add</button></div>
    {courses.length===0&&<div className="empty">No courses yet.</div>}
    <div className="home-grid">
      {courses.map(c=>{const openA=state.assignments.filter(a=>a.courseId===c.id&&!a.done);const openE=state.exams.filter(e=>e.courseId===c.id&&!e.done);const isOpen=!!expandedCourse[c.id];const nextA=openA.filter(a=>a.dueDate).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];const nextE=[...openE].sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];const hasUrgent=openA.some(a=>{const d=daysUntil(a.dueDate);return d!==null&&d<=2;})||openE.some(e=>{const d=daysUntil(e.dueDate);return d!==null&&d<=5;});return <div key={c.id} className="course-card" style={{borderLeftColor:c.color}}><div role="button" tabIndex={0} className="course-card-compact" onClick={()=>setExpandedCourse(x=>({...x,[c.id]:!x[c.id]}))} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&setExpandedCourse(x=>({...x,[c.id]:!x[c.id]}))}><div className="course-card-left"><div className="course-card-name">{c.name}</div><div className="course-card-pills">{openA.length>0&&<span className={"course-card-pill"+(hasUrgent?" urgent":"")}>{openA.length} due</span>}{openE.length>0&&<span className="course-card-pill" style={{background:"rgba(109,63,160,0.08)",color:"#6d3fa0",borderColor:"rgba(109,63,160,0.18)"}}>{openE.length} exam{openE.length!==1?"s":""}</span>}{openA.length===0&&openE.length===0&&<span className="course-card-pill" style={{color:"#2e7d52",borderColor:"rgba(46,125,82,0.2)"}}>clear</span>}</div></div><span className={"course-card-chevron"+(isOpen?" open":"")}>▶</span></div>{isOpen&&<div className="course-card-detail"><div className="course-card-next">{nextE&&<div style={{color:"#6d3fa0",marginBottom:5,fontFamily:"var(--font-mono)",fontSize:11}}>📝 <strong>{nextE.title}</strong> — {urgencyLabel(daysUntil(nextE.dueDate))}</div>}{nextA&&<div style={{marginBottom:5}}>Next: <strong>{nextA.title}</strong><span style={{color:urgencyColor(daysUntil(nextA.dueDate)),marginLeft:6,fontFamily:"var(--font-mono)",fontSize:11}}>{urgencyLabel(daysUntil(nextA.dueDate))}</span></div>}{!nextA&&!nextE&&<span style={{color:"var(--muted2)",fontFamily:"var(--font-mono)",fontSize:11}}>Nothing due — all clear</span>}</div><div className="course-card-actions"><button className="btn-outline btn-sm" onClick={()=>onEditCourse({id:c.id,name:c.name,color:c.color})}>Edit</button></div></div>}</div>;})}
    </div>
  </div>;
}

// ── ExamCard ──────────────────────────────────────────────────────────────────
function ExamCard({ exam, courses, dispatch }) {
  const [topicInput, setTopicInput] = useState("");
  const [open, setOpen] = useState(false);
  const course=courses[exam.courseId]; const days=daysUntil(exam.dueDate);
  const studyStart=studyStartDate(exam); const studyDays=daysUntil(studyStart);
  const diff=exam.difficulty||"medium"; const topics=exam.topics||[];
  const doneCnt=topics.filter(t=>t.done).length;
  const pct=topics.length>0?Math.round((doneCnt/topics.length)*100):0;
  const progressColor=pct===100?"#2e7d52":pct>50?"#d4860a":"#c0392b";
  const addTopic=()=>{ if(!topicInput.trim()) return; dispatch({type:"ADD_EXAM_TOPIC",examId:exam.id,title:topicInput.trim()}); setTopicInput(""); };
  return <div className={"exam-card"+(exam.done?" done":"")} style={{borderLeftColor:course?.color||"var(--border2)"}}>
    <div className="exam-card-header" onClick={()=>setOpen(o=>!o)}>
      <div className={"asgn-check"+(exam.done?" checked":"")} style={{marginTop:5,flexShrink:0}} onClick={e=>{e.stopPropagation();dispatch({type:"TOGGLE_EXAM",id:exam.id});}}/>
      <div className="exam-card-header-info">
        <div className={"exam-card-title"+(exam.done?" done":"")}>{exam.title}</div>
        <div className="exam-card-meta">
          {course&&<span className="asgn-course" style={{background:course.color+"18",color:course.color}}>{course.name}</span>}
          <span className="tag tag-exam">EXAM</span>
          {exam.dueDate&&<span style={{fontFamily:"var(--font-mono)",fontSize:11,fontWeight:500,color:exam.done?"var(--muted2)":urgencyColor(days)}}>{fmtDate(exam.dueDate)} · {urgencyLabel(days)}</span>}
        </div>
        {topics.length>0&&<div className="exam-header-progress"><div className="exam-header-progress-track"><div className="exam-header-progress-fill" style={{width:pct+"%",background:progressColor}}/></div><span className="exam-header-progress-txt">{doneCnt}/{topics.length} topics{pct===100?" ✓":""}</span></div>}
      </div>
      <span style={{fontSize:10,color:"var(--muted2)",transform:open?"rotate(90deg)":"rotate(0deg)",transition:"transform 0.2s",flexShrink:0,marginLeft:6}}>▶</span>
      <button className="btn-danger-text" style={{flexShrink:0}} onClick={e=>{e.stopPropagation();dispatch({type:"DELETE_EXAM",id:exam.id});}}>×</button>
    </div>
    {open&&<div className="exam-card-body">
      {exam.notes&&<div className="exam-card-notes">{exam.notes}</div>}
      {!exam.done&&<div className="study-plan-bar">
        <span className="study-plan-label">DIFFICULTY:</span>
        {["easy","medium","hard","brutal"].map(d=><span key={d} className="difficulty-pill" style={{background:diff===d?DIFFICULTY_COLORS[d]+"18":"transparent",color:diff===d?DIFFICULTY_COLORS[d]:"var(--muted2)",borderColor:diff===d?DIFFICULTY_COLORS[d]:"var(--border2)"}} onClick={()=>dispatch({type:"UPDATE_EXAM_DIFFICULTY",id:exam.id,difficulty:d})}>{DIFFICULTY_LABELS[d]}</span>)}
      </div>}
      {!exam.done&&exam.dueDate&&<div className="study-plan-bar"><span className="study-plan-label">START STUDYING:</span><span className="study-plan-date">{fmtDateFull(studyStart)}</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,color:studyDays<=0?"#c0392b":studyDays<=3?"#d4860a":"var(--muted)"}}>({studyDays<=0?"now":"in "+studyDays+"d"})</span></div>}
      <div className="topics-section">
        <div className="topics-section-header">
          <span className="topics-section-label">Topics</span>
          {topics.length>0&&<><div className="topics-big-progress-wrap"><div className="topics-big-progress-bar" style={{width:pct+"%",background:progressColor}}/></div><span className="topics-big-progress-txt">{pct}%</span></>}
        </div>
        {topics.length===0&&<div className="topics-empty">No topics yet — add what you need to cover</div>}
        {topics.map(t=><div key={t.id} className="topic-item" onClick={()=>dispatch({type:"TOGGLE_EXAM_TOPIC",examId:exam.id,topicId:t.id})}>
          <div className={"topic-check"+(t.done?" checked":"")}/>
          <span className={"topic-title"+(t.done?" done":"")}>{t.title}</span>
          <button className="topic-del" onClick={e=>{e.stopPropagation();dispatch({type:"DELETE_EXAM_TOPIC",examId:exam.id,topicId:t.id});}}>×</button>
        </div>)}
        <div className="topic-add-row">
          <input type="text" placeholder="Add a topic…" value={topicInput} onChange={e=>setTopicInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addTopic()}/>
          <button className="topic-add-btn" onClick={addTopic}>Add</button>
        </div>
      </div>
    </div>}
  </div>;
}

// ── ActionsView — Next Up ─────────────────────────────────────────────────────
function ActionsView({ state, dispatch, showFlash }) {
  const [newText, setNewText] = useState(""); const [newBucket, setNewBucket] = useState("today"); const [newCourse, setNewCourse] = useState("");
  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
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
      if(incompTopics.length>0){actions.push({id:"sugg-e-"+e.id,text:"Study for "+(c?c.name+": ":"")+e.title+" — "+incompTopics[0].title+(incompTopics.length>1?" (+"+( incompTopics.length-1)+" more)":""),bucket,sourceId:e.id,sourceType:"exam",suggested:true,courseId:e.courseId||null,done:false});}
      else{actions.push({id:"sugg-e-"+e.id,text:"Prepare for "+(c?c.name+": ":"")+e.title,bucket,sourceId:e.id,sourceType:"exam",suggested:true,courseId:e.courseId||null,done:false});}
    });
    return actions;
  })();
  // Auto-purge manual actions: done items cleared at 3am the following day
  const now = Date.now();
  const next3am = (() => {
    const d = new Date(); d.setHours(3, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  })();
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
  const addAction = () => { if(!newText.trim()) return; dispatch({type:"ADD_ACTION",text:newText.trim(),bucket:newBucket,courseId:newCourse||null}); setNewText(""); showFlash("Added to Next Up"); };
  if(totalDeadlines < 1) return <div>
    <div className="nextup-unlock">
      <div className="nextup-unlock-icon">◎</div>
      <div className="nextup-unlock-body">
        <div className="nextup-unlock-title">Add a deadline to unlock your study plan</div>
        <div className="nextup-unlock-sub">Next Up surfaces your most urgent work automatically. Add an assignment or exam to get started.</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
          <button className="btn btn-sm" onClick={()=>dispatch({type:"SET_VIEW",view:"plan"})}>Go to Plan →</button>
        </div>
      </div>
    </div>
  </div>;
  return <div>
    {BUCKETS.map(bucket=>{
      const items=allActions.filter(a=>a.bucket===bucket);
      if(items.length===0) return null;
      const col=BUCKET_COLORS[bucket];
      return <div key={bucket} className="bucket-section">
        <div className="bucket-header"><div className="bucket-dot" style={{background:col.bg}}/>{BUCKET_LABELS[bucket]}</div>
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
          {a.suggested&&<span style={{fontFamily:"var(--font-mono)",fontSize:9,color:"#1a5c9e",letterSpacing:"0.06em",flexShrink:0}}>AUTO</span>}
        </div>)}
      </div>;
    })}
    <div className="divider"/>
    <div className="section-label">Add manually</div>
    <div className="quick-add-box">
      <div className="input-row">
        <input type="text" placeholder="What do you need to do?" value={newText} onChange={e=>setNewText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addAction()} style={{flex:2}}/>
        <select value={newBucket} onChange={e=>setNewBucket(e.target.value)} style={{flex:1,maxWidth:130}}>{BUCKETS.map(b=><option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}</select>
        <button className="btn" onClick={addAction}>Add</button>
      </div>
      {courses.length>0&&<select value={newCourse} onChange={e=>setNewCourse(e.target.value)} style={{marginTop:8,fontSize:12}}>
        <option value="">No course</option>
        {courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
      </select>}
    </div>
  </div>;
}
