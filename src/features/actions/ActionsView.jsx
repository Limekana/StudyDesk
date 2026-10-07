import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { setLanguage, SUPPORTED_LANGS, LANGUAGE_NAMES } from "../../i18n/index.js";
import { useScrollSelectedIntoView } from "../../lib/useScrollSelectedIntoView.js";
import { daysUntil } from "../../lib/deadlines.js";
import { enterSubmit } from "../../lib/imeSubmit.js";
import FirstSteps from "../onboarding/FirstSteps.jsx";

const BUCKETS = ["today", "this_week", "later"];
const BUCKET_COLORS = {
  today:     { bg: "#c0392b", text: "#fff" },
  this_week: { bg: "#d4860a", text: "#fff" },
  later:     { bg: "#2e7d52", text: "#fff" },
};

// ── ActionsView — Next Up ─────────────────────────────────────────────────────
export default function ActionsView({ state, dispatch, showFlash, onAddCourse, onFirstStep }) {
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
    {/* v1.14 — the funnel gap. Above the buckets rather than below them: a
        suggestion under a screenful of content is a suggestion nobody sees,
        and this one self-hides the moment it stops applying. It renders only
        here, on the landing view, because the two empty states above already
        carry their own prompt and stacking a second would be the wizard this
        deliberately is not. */}
    <FirstSteps state={state} onGo={onFirstStep}/>
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
