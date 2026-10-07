import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { readCollapsed, writeCollapsed } from "../../lib/planSections.js";
import { preferredDueWindow, countsAsDue } from "../../lib/dueWindow.js";
import { byDueAsc, byDueDesc } from "../../lib/dueAt.js";
import { daysUntil, urgencyColor, urgencyLabel } from "../../lib/deadlines.js";
import AsgnItem from "./AsgnItem.jsx";
import ExamCard from "./ExamCard.jsx";

// ── PlanSectionHead ───────────────────────────────────────────────────────────
//
// v1.14 Item 3 (#51) — the LIST view's three section headings, now foldable.
//
// The chevron is `course-card-chevron`, the same mark the course cards below
// already use for exactly this gesture, rather than a second one that means the
// same thing: the tab teaches the affordance once. It also inherits the RTL
// mirroring rule those cards already carry.
//
// The heading text becomes the button and the Add button stays a sibling, so
// `.section-label`'s ordering rules — hairline at order 1, action at order 2 —
// keep working untouched, and the Add buttons stay aligned down the right edge
// whether a section is open or shut.
function PlanSectionHead({ id, label, open, onToggle, children }) {
  return (
    <div className="section-label">
      {/* No aria-controls: the section body is a fragment of siblings rather
          than one element, so there is nothing honest to point at.
          aria-expanded alone is valid and is what gets announced. */}
      <button
        type="button"
        className="section-toggle"
        onClick={() => onToggle(id)}
        aria-expanded={open}
      >
        <span className={"course-card-chevron" + (open ? " open" : "")} aria-hidden="true">▶</span>
        {label}
      </button>
      {children}
    </div>
  );
}

export default function PlanView({ state, dispatch, session, showFlash, onAddAsgn, onAddExam, onAddCourse, onEditCourse, onOpenCalendar }) {
  const { t } = useTranslation();
  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
  const [expandedCourse, setExpandedCourse] = useState({});
  // Read once at mount, not on every render: the value only ever changes
  // through the toggle below, and reading localStorage per render would make
  // scrolling this tab hit storage.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Read at render, like `resolveWeekStart` and `preferredDayStart` elsewhere:
  // a localStorage write is invisible to React, and this view remounts when the
  // user comes back from Settings, which is the only place it can change.
  const dueWindow = preferredDueWindow();
  const toggleSection = useCallback((id) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      writeCollapsed(next);
      return next;
    });
  }, []);
  const openAsgns=state.assignments.filter(a=>!a.done).sort(byDueAsc);
  const openExams=state.exams.filter(e=>!e.done).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
  // The root is NOT a tiling grid: this view also holds the course cards,
  // and tiling those would break them.
  // Only the flat lists tile, which is where the vertical length comes from.
  return <div className="sd-page-plan">
    <PlanSectionHead id="assignments" label={t('av.pl.assignments')} open={!collapsed.assignments} onToggle={toggleSection}>
      <button className="btn btn-sm" onClick={onAddAsgn}>{t('av.pl.add')}</button>
    </PlanSectionHead>
    {!collapsed.assignments && <>
    {openAsgns.length===0&&<div className="empty">{t('av.pl.noOpenAsgn')}</div>}
    <div className="sd-list-tile">{openAsgns.map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash}/>)}</div>
    {state.assignments.filter(a=>a.done).length>0&&<details style={{marginBottom:16}}><summary style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",cursor:"pointer",padding:"8px 0"}}>{t('av.pl.completed',{count:state.assignments.filter(a=>a.done).length})}</summary>{state.assignments.filter(a=>a.done).sort(byDueDesc).map(a=><AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash}/>)}</details>}
    </>}
    <div className="divider"/>
    <PlanSectionHead id="exams" label={t('cal.statExams')} open={!collapsed.exams} onToggle={toggleSection}>
      <button className="btn btn-sm" onClick={onAddExam}>{t('av.pl.add')}</button>
    </PlanSectionHead>
    {!collapsed.exams && <>
    {/* v1.15 Item 1 — this section used to carry its own month grid and a
        60-day agenda: a second calendar with separate logic from the Calendar
        tab beside it, and the source of "three different calendars". The one
        calendar is a tap away; the exam cards below are the summary. */}
    <button type="button" className="btn-outline btn-sm plan-open-cal" onClick={onOpenCalendar}>
      {t('cal.planCalendar')} <span className="rtl-mirror" aria-hidden>→</span>
    </button>
    {openExams.map(e=><ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch}/>)}
    {openExams.length===0&&<div className="empty">{t('av.pl.noExams')}</div>}
    {state.exams.filter(e=>e.done).length>0&&<details style={{marginBottom:16}}><summary style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",cursor:"pointer",padding:"8px 0"}}>{t('av.pl.completedExams',{count:state.exams.filter(e=>e.done).length})}</summary>{state.exams.filter(e=>e.done).map(e=><ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch}/>)}</details>}
    </>}
    {/* Hidden on phones by CSS: the course chip strip at the top of Plan
        already lists every course (plus Add course), and course detail has
        the Edit button, so a second list at the bottom only repeated it.
        Tablet and desktop keep it — they have no chip strip. */}
    <div className="plan-courses">
    <div className="divider"/>
    <PlanSectionHead id="courses" label={t('av.pl.courses')} open={!collapsed.courses} onToggle={toggleSection}>
      <button className="btn btn-sm" onClick={onAddCourse}>{t('av.pl.add')}</button>
    </PlanSectionHead>
    {!collapsed.courses && <>
    {courses.length===0&&<div className="empty">{t('av.pl.noCourses')}</div>}
    <div className="home-grid">
      {courses.map(c=>{const openA=state.assignments.filter(a=>a.courseId===c.id&&!a.done);const openE=state.exams.filter(e=>e.courseId===c.id&&!e.done);const isOpen=!!expandedCourse[c.id];const dueA=openA.filter(a=>countsAsDue(daysUntil(a.dueDate),a.type,dueWindow));const nextA=openA.filter(a=>a.dueDate).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];const nextE=[...openE].sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];const hasUrgent=openA.some(a=>{const d=daysUntil(a.dueDate);return d!==null&&d<=2;})||openE.some(e=>{const d=daysUntil(e.dueDate);return d!==null&&d<=5;});return <div key={c.id} className="course-card" style={{borderInlineStartColor:c.color}}><div role="button" tabIndex={0} className="course-card-compact" onClick={()=>setExpandedCourse(x=>({...x,[c.id]:!x[c.id]}))} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&setExpandedCourse(x=>({...x,[c.id]:!x[c.id]}))}><div className="course-card-left"><div className="course-card-name">{c.name}</div><div className="course-card-pills">{dueA.length>0&&<span className={"course-card-pill"+(hasUrgent?" urgent":"")} title={t('av.pl.dueTitle',{due:dueA.length,open:openA.length})}>{t('av.pl.due',{count:dueA.length})}</span>}{dueA.length===0&&openA.length>0&&<span className="course-card-pill" title={t('av.pl.openTitle',{count:openA.length})}>{t('av.pl.open',{count:openA.length})}</span>}{openE.length>0&&<span className="course-card-pill" style={{background:"rgba(109,63,160,0.08)",color:"#6d3fa0",borderColor:"rgba(109,63,160,0.18)"}}>{t('av.pl.exam',{count:openE.length})}</span>}{openA.length===0&&openE.length===0&&<span className="course-card-pill" style={{color:"#2e7d52",borderColor:"rgba(46,125,82,0.2)"}}>{t('av.pl.clear')}</span>}</div></div><span className={"course-card-chevron"+(isOpen?" open":"")}>▶</span></div>{isOpen&&<div className="course-card-detail"><div className="course-card-next">{nextE&&<div style={{color:"#6d3fa0",marginBottom:5,fontFamily:"var(--font-mono)",fontSize:11}}>📝 <strong>{nextE.title}</strong> — {urgencyLabel(daysUntil(nextE.dueDate),t)}</div>}{nextA&&<div style={{marginBottom:5}}>{t('av.pl.next')} <strong>{nextA.title}</strong><span style={{color:urgencyColor(daysUntil(nextA.dueDate)),marginLeft:6,fontFamily:"var(--font-mono)",fontSize:11}}>{urgencyLabel(daysUntil(nextA.dueDate),t)}</span></div>}{!nextA&&!nextE&&<span style={{color:"var(--muted2)",fontFamily:"var(--font-mono)",fontSize:11}}>{t('av.pl.nothingDue')}</span>}</div><div className="course-card-actions"><button className="btn-outline btn-sm" onClick={()=>onEditCourse({id:c.id,name:c.name,color:c.color})}>{t('av.pl.edit')}</button></div></div>}</div>;})}
    </div>
    </>}
    </div>
  </div>;
}
