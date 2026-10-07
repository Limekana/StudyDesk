import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip } from "lucide-react";
import { fmtDate } from "../../lib/dates.js";
import { daysUntil, urgencyColor, urgencyLabel } from "../../lib/deadlines.js";
import AttachmentList from "./Attachments.jsx";
import { useAttachmentDrop } from "./useAttachmentDrop.js";

export default function AsgnItem({ asgn, courses, dispatch, attachments = [], session, showFlash }) {
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
  const [editTime,setEditTime]=useState(asgn.dueTime||"");
  const [editNotes,setEditNotes]=useState(asgn.notes||"");
  // Clearing the date clears the time with it: a time with no day is not a
  // deadline, and leaving it behind would resurrect it if a date came back.
  const save=()=>{ dispatch({type:"EDIT_ASSIGNMENT",id:asgn.id,title:editTitle.trim()||asgn.title,dueDate:editDate,dueTime:editDate?editTime:"",notes:editNotes}); setEditing(false); };
  if(editing) return <div className="asgn-item" style={{flexDirection:"column",gap:10}}>
    <input type="text" value={editTitle} onChange={e=>setEditTitle(e.target.value)} style={{fontWeight:500}} autoFocus/>
    <div style={{display:"flex",gap:8}}>
      <input type="date" value={editDate} onChange={e=>setEditDate(e.target.value)} style={{flex:"1 1 auto"}}/>
      <input type="time" value={editTime} disabled={!editDate} onChange={e=>setEditTime(e.target.value)} style={{flex:"0 1 auto"}} aria-label={t('av.md.dueTimeOpt')}/>
    </div>
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
        {asgn.dueDate&&<span className="asgn-due" style={{color:asgn.done?"var(--muted2)":urgencyColor(days)}}>{fmtDate(asgn.dueDate,t)}{asgn.dueTime&&` ${asgn.dueTime}`} · {urgencyLabel(days,t)}</span>}
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
