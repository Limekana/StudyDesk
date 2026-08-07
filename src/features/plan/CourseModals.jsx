// The three course/assignment/exam modals — SD-6.
//
// Extracted verbatim from App.jsx, which held 12 components and ~380 lines of
// CSS in one 2,216-line file. The audit's complaint was concrete rather than
// aesthetic: the v1.8 assignment-type change and the RTL sweep both had to be
// made as careful edits to that single file because unrelated features were
// interleaved, and any merge touching two of them conflicted.
//
// These three are leaves — they take props and call back, hold no shared state,
// and reach nothing in App's closure — which is why they move without any
// rewiring. Their markup is unchanged.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import CoursePicker from '../../lib/CoursePicker.jsx';
import { ASSIGN_TYPES, OTHER_ASSIGN_TYPE } from '../../lib/assignTypes.js';
import { DIFFICULTY_DAYS, DIFFICULTY_COLORS } from '../../lib/examDifficulty.js';
import { addDays, fmtDateFull } from '../../lib/dates.js';

export function AddAsgnModal({ courses, activeCourse, onAdd, onClose }) {
  const { t } = useTranslation();
  const [title,setTitle]=useState(""); const [courseId,setCourse]=useState(activeCourse||(courses[0]?.id??"")); const [type,setType]=useState(ASSIGN_TYPES[0]); const [dueDate,setDueDate]=useState(""); const [notes,setNotes]=useState("");
  // v1.8 — "Other" used to be a dead end: it stored the literal string "Other"
  // with no way to say what the assignment actually was. Picking it now reveals
  // a label field and the custom text is what gets stored, so `type` stays a
  // plain string and no existing assignment changes shape. Assignments are
  // local-only — no Supabase table exists and NCC never reads them — so this
  // has no sync or cross-app surface.
  const [customType,setCustomType]=useState("");
  const isOtherType = type===OTHER_ASSIGN_TYPE;
  const resolvedType = isOtherType ? customType.trim() : type;
  const submit=()=>{ if(!title.trim()||!courseId||!resolvedType) return; onAdd({title:title.trim(),courseId,type:resolvedType,dueDate,notes}); };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t('av.md.addAssignment')} onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
    <div className="modal-title">{t('av.md.addAssignment')}</div>
    <div className="input-group"><div className="input-label">{t('av.md.title')}</div><input type="text" placeholder={t('av.md.titlePh')} value={title} onChange={e=>setTitle(e.target.value)} autoFocus/></div>
    <div className="modal-grid">
      <div className="input-group"><div className="input-label">{t('av.md.course')}</div><select value={courseId} onChange={e=>setCourse(e.target.value)}>{courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="input-group"><div className="input-label">{t('av.md.type')}</div><select value={type} onChange={e=>setType(e.target.value)}>{ASSIGN_TYPES.map(ty=><option key={ty} value={ty}>{t(`av.assignType.${ty}`,{defaultValue:ty})}</option>)}</select></div>
    </div>
    {isOtherType&&<div className="input-group"><input type="text" placeholder={t('av.md.typeCustomPh')} value={customType} onChange={e=>setCustomType(e.target.value)} aria-label={t('av.md.type')} autoFocus/></div>}
    <div className="input-group"><div className="input-label">{t('av.md.dueDateOpt')}</div><input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></div>
    <div className="input-group"><div className="input-label">{t('av.md.notesOpt')}</div><textarea placeholder={t('av.md.asgnNotesPh')} value={notes} onChange={e=>setNotes(e.target.value)} style={{minHeight:60}}/></div>
    <div style={{display:"flex",gap:8,marginTop:4}}><button className="btn" onClick={submit}>{t('av.md.addAssignment')}</button><button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button></div>
  </div></div>;
}

export function AddExamModal({ courses, activeCourse, onAdd, onClose }) {
  const { t } = useTranslation();
  const [title,setTitle]=useState(""); const [courseId,setCourse]=useState(activeCourse||(courses[0]?.id??"")); const [dueDate,setDueDate]=useState(""); const [difficulty,setDiff]=useState("medium"); const [notes,setNotes]=useState("");
  const submit=()=>{ if(!title.trim()||!courseId||!dueDate) return; onAdd({title:title.trim(),courseId,dueDate,difficulty,notes}); };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t('av.md.addExam')} onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
    <div className="modal-title">{t('av.md.addExam')}</div>
    <div className="input-group"><div className="input-label">{t('av.md.examSubject')}</div><input type="text" placeholder={t('av.md.examTitlePh')} value={title} onChange={e=>setTitle(e.target.value)} autoFocus/></div>
    <div className="modal-grid">
      <div className="input-group"><div className="input-label">{t('av.md.course')}</div><select value={courseId} onChange={e=>setCourse(e.target.value)}>{courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="input-group"><div className="input-label">{t('av.md.examDate')}</div><input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></div>
    </div>
    <div className="input-group"><div className="input-label">{t('av.md.difficultyLabel')}</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {["easy","medium","hard","brutal"].map(d=>(
          <span key={d} className="difficulty-pill" style={{background:difficulty===d?DIFFICULTY_COLORS[d]+"18":"transparent",color:difficulty===d?DIFFICULTY_COLORS[d]:"var(--muted2)",borderColor:difficulty===d?DIFFICULTY_COLORS[d]:"var(--border2)",padding:"6px 14px",fontSize:12}} onClick={()=>setDiff(d)}>
            {t(`av.difficulty.${d}`)} <span style={{opacity:0.6,fontSize:10}}>({DIFFICULTY_DAYS[d]}d)</span>
          </span>
        ))}
      </div>
    </div>
    {dueDate&&<div style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",marginBottom:12,padding:"8px 12px",background:"var(--surface2)",borderRadius:4}}>
      📚 {t('av.ec.studyStart')} <strong>{fmtDateFull(addDays(dueDate,-DIFFICULTY_DAYS[difficulty]))}</strong>
    </div>}
    <div className="input-group"><div className="input-label">{t('av.md.notesOpt')}</div><textarea placeholder={t('av.md.examNotesPh')} value={notes} onChange={e=>setNotes(e.target.value)} style={{minHeight:60}}/></div>
    <div style={{display:"flex",gap:8,marginTop:4}}><button className="btn" onClick={submit}>{t('av.md.addExam')}</button><button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button></div>
  </div></div>;
}

export function EditCourseModal({ course, courses, onSave, onDelete, onClose }) {
  const { t } = useTranslation();
  const [name,setName]=useState(course.name);
  const [color,setColor]=useState(course.color);
  const [credits,setCredits]=useState(course.credits!=null?String(course.credits):"1");
  const [semester,setSemester]=useState(course.semester||"");
  const [schoolYear,setSchoolYear]=useState(course.schoolYear||"");
  const [confirmDelete,setConfirmDelete]=useState(false);
  // v1.5 — autocomplete options from previously-used period / school-year
  // values so free-text input stays consistent before the history view (5C).
  const allCourses = Object.values(courses||{});
  const periodOptions = [...new Set(allCourses.map(c=>c.semester).filter(Boolean))].sort();
  const yearOptions = [...new Set(allCourses.map(c=>c.schoolYear).filter(Boolean))].sort();
  const doSave = () => {
    if(!name.trim()) return;
    const cr = parseFloat(credits);
    onSave(name.trim(), color, isNaN(cr)||cr<0?1:cr, semester.trim()||null, schoolYear.trim()||null);
  };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t('course.edit')} onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()}>
    <div className="modal-title">{t('course.edit')}</div>
    <div className="input-group"><div className="input-label">{t('course.name')}</div><input type="text" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSave()} autoFocus/></div>
    <div className="modal-grid">
      <div className="input-group"><div className="input-label">{t('course.credits')}</div><input type="number" step="0.5" min="0" value={credits} onChange={e=>setCredits(e.target.value)}/></div>
      <div className="input-group"><div className="input-label">{t('course.period')}</div><input type="text" list="period-options" placeholder={t('course.periodPlaceholder')} value={semester} onChange={e=>setSemester(e.target.value)}/>
        <datalist id="period-options">{periodOptions.map(p=><option key={p} value={p}/>)}</datalist></div>
    </div>
    <div className="input-group"><div className="input-label">{t('course.schoolYear')}</div><input type="text" list="schoolyear-options" placeholder={t('course.yearPlaceholder')} value={schoolYear} onChange={e=>setSchoolYear(e.target.value)}/>
      <datalist id="schoolyear-options">{yearOptions.map(y=><option key={y} value={y}/>)}</datalist></div>
    <div className="input-group"><div className="input-label">{t('course.color')}</div>
      <CoursePicker value={color} onChange={setColor}/>
    </div>
    {/* v1.10 — the confirmation replaces the footer rather than joining it.
        Previously the question and both answers were pushed into the same flex
        row as Save and Cancel, which is why the text "doesnt quite fit in":
        five items competing for one modal width, with the question the only
        one that could shrink. Asking someone to confirm a destructive action
        while still offering Save is also a muddle — one question at a time. */}
    {confirmDelete
      ?<div className="confirm-delete">
        <div className="confirm-delete-q">{t('course.deleteConfirm')}</div>
        {/* Equal width, distinguished by colour rather than size. Weighting the
            destructive button larger is a defensible pattern, but here it was
            an accident of two different classes — .btn-red is 11px/8x16 and
            .btn-outline 10px/7x14 — compounded by "Yes, delete" being five
            times the length of "No". */}
        <div className="confirm-delete-actions">
          <button className="btn-red" onClick={onDelete}>{t('course.yesDelete')}</button>
          <button className="btn-outline" onClick={()=>setConfirmDelete(false)}>{t('course.no')}</button>
        </div>
      </div>
      :<div style={{display:"flex",gap:8,marginTop:8,alignItems:"center"}}>
        <button className="btn" onClick={doSave}>{t('common.save')}</button>
        <button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <span style={{flex:1}}/>
        <button className="btn-outline" style={{color:"#c0392b",borderColor:"#c0392b"}} onClick={()=>setConfirmDelete(true)}>{t('course.delete')}</button>
      </div>}
  </div></div>;
}

// ── PlanView — unified planning surface (assignments + exams + courses) ────────
