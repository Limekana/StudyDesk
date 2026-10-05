import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { fmtDate, fmtDateFull } from "../../lib/dates.js";
import { DIFFICULTY_COLORS } from "../../lib/examDifficulty.js";
import { daysUntil, studyStartDate, urgencyColor, urgencyLabel } from "../../lib/deadlines.js";
import { enterSubmit } from "../../lib/imeSubmit.js";

// ── ExamCard ──────────────────────────────────────────────────────────────────
export default function ExamCard({ exam, courses, dispatch }) {
  const { t } = useTranslation();
  const [topicInput, setTopicInput] = useState("");
  const [open, setOpen] = useState(false);
  // v1.13 (#45). Same shape as AsgnItem's inline editor rather than a modal:
  // an exam card is already an expandable panel, and a modal over it would be
  // a second layer for a three-field form.
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(exam.title);
  const [eDate, setEDate] = useState(exam.dueDate || "");
  const [eNotes, setENotes] = useState(exam.notes || "");
  const [eDiff, setEDiff] = useState(exam.difficulty || "medium");
  const startEdit = () => {
    // Re-seed from the row on every open. Without this, editing, cancelling,
    // and reopening shows the abandoned draft rather than what is stored.
    setETitle(exam.title); setEDate(exam.dueDate || "");
    setENotes(exam.notes || ""); setEDiff(exam.difficulty || "medium");
    setEditing(true);
  };
  const saveEdit = () => {
    dispatch({
      type: "EDIT_EXAM",
      id: exam.id,
      // A blank title falls back rather than clearing: an exam with no name
      // is unusable, and the delete button is right there for people who mean
      // to remove it.
      title: eTitle.trim() || exam.title,
      dueDate: eDate || null,
      notes: eNotes,
      difficulty: eDiff,
    });
    setEditing(false);
  };
  const course=courses[exam.courseId]; const days=daysUntil(exam.dueDate);
  const studyStart=studyStartDate(exam); const studyDays=daysUntil(studyStart);
  const diff=exam.difficulty||"medium"; const topics=exam.topics||[];
  const doneCnt=topics.filter(t=>t.done).length;
  const pct=topics.length>0?Math.round((doneCnt/topics.length)*100):0;
  const progressColor=pct===100?"var(--success)":pct>50?"var(--warning)":"var(--danger)";
  const addTopic=()=>{ if(!topicInput.trim()) return; dispatch({type:"ADD_EXAM_TOPIC",examId:exam.id,title:topicInput.trim()}); setTopicInput(""); };
  if (editing) return <div className="exam-card" style={{borderInlineStartColor:course?.color||"var(--border2)",flexDirection:"column",gap:10,padding:14}}>
    <input type="text" value={eTitle} onChange={e=>setETitle(e.target.value)} style={{fontWeight:500}} autoFocus aria-label={t('sv.fTitle')}/>
    <input type="date" value={eDate} onChange={e=>setEDate(e.target.value)} aria-label={t('av.ec.examDate')}/>
    <div className="study-plan-bar">
      <span className="study-plan-label">{t('av.ec.difficulty')}</span>
      {["easy","medium","hard","brutal"].map(d=>(
        <span key={d} className="difficulty-pill"
          style={{background:eDiff===d?DIFFICULTY_COLORS[d]+"18":"transparent",color:eDiff===d?DIFFICULTY_COLORS[d]:"var(--muted2)",borderColor:eDiff===d?DIFFICULTY_COLORS[d]:"var(--border2)"}}
          onClick={()=>setEDiff(d)}>{t(`av.difficulty.${d}`)}</span>
      ))}
    </div>
    <textarea value={eNotes} onChange={e=>setENotes(e.target.value)} placeholder={t('sv.fNotes')+"…"} style={{minHeight:48,fontSize:12}}/>
    <div style={{display:"flex",gap:8}}>
      <button className="btn btn-sm" onClick={saveEdit}>{t('common.save')}</button>
      <button className="btn-outline btn-sm" onClick={()=>setEditing(false)}>{t('common.cancel')}</button>
    </div>
  </div>;
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
      {/* v1.13 (#45). Beside delete, because that is where somebody who wants
          to change an exam has been going and finding only delete. */}
      <button className="exam-edit-btn" style={{flexShrink:0}} onClick={e=>{e.stopPropagation();startEdit();}} aria-label={t('av.ec.editExam')} title={t('av.ec.editExam')}>
        <Pencil size={13} strokeWidth={1.75}/>
      </button>
      <button className="btn-danger-text" style={{flexShrink:0}} onClick={e=>{e.stopPropagation();dispatch({type:"DELETE_EXAM",id:exam.id});}}>×</button>
    </div>
    {open&&<div className="exam-card-body">
      {exam.notes&&<div className="exam-card-notes">{exam.notes}</div>}
      {!exam.done&&<div className="study-plan-bar">
        <span className="study-plan-label">{t('av.ec.difficulty')}</span>
        {["easy","medium","hard","brutal"].map(d=><span key={d} className="difficulty-pill" style={{background:diff===d?DIFFICULTY_COLORS[d]+"18":"transparent",color:diff===d?DIFFICULTY_COLORS[d]:"var(--muted2)",borderColor:diff===d?DIFFICULTY_COLORS[d]:"var(--border2)"}} onClick={()=>dispatch({type:"UPDATE_EXAM_DIFFICULTY",id:exam.id,difficulty:d})}>{t(`av.difficulty.${d}`)}</span>)}
      </div>}
      {!exam.done&&exam.dueDate&&<div className="study-plan-bar"><span className="study-plan-label">{t('av.ec.startStudying')}</span><span className="study-plan-date">{fmtDateFull(studyStart)}</span><span style={{fontFamily:"var(--font-mono)",fontSize:11,color:studyDays<=0?"var(--danger)":studyDays<=3?"var(--warning)":"var(--muted)"}}>({studyDays<=0?t('av.ec.now'):t('av.ec.inDays',{n:studyDays})})</span></div>}
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
