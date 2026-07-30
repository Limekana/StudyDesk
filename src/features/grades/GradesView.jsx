import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateGPA, subjectEffectiveGrade, subjectsWithEffectiveGrades } from '../../lib/gpa.js';
import { scaleFor, describeScale } from '../../lib/gradeScale.js';
import * as outbox from '../../lib/outbox.js';

// Grade rows go straight to Supabase, where `id` is a strict UUID column.
// crypto.randomUUID() is browser-native (since Chromium 92 / 2021) — Capacitor's
// WebView is well above that. Don't use a short nanoid here, Postgres rejects
// non-UUID strings with "invalid input syntax for type uuid".
function uid() { return crypto.randomUUID(); }

const css = `
.gv-wrap{padding:16px 24px 80px;max-width:980px;margin:0 auto;}
.gv-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px;}
.gv-gpa{display:flex;flex-direction:column;}
.gv-gpa-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;color:var(--muted2);text-transform:uppercase;}
.gv-gpa-value{font-family:var(--font-display);font-size:54px;font-weight:600;line-height:1;letter-spacing:-0.02em;}
.gv-gpa-scale{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-top:4px;letter-spacing:0.05em;}
.gv-mode{display:flex;gap:0;border:1px solid var(--border2);border-radius:6px;overflow:hidden;}
.gv-mode button{background:transparent;border:none;padding:7px 16px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;color:var(--muted);transition:all 0.1s;}
.gv-mode button.active{background:var(--text);color:var(--bg);}
.gv-toolbar{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap;}
.gv-subject{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;cursor:pointer;transition:border-color 0.1s;}
.gv-subject:hover{border-color:var(--border2);}
.gv-subject-head{display:flex;align-items:center;gap:10px;}
.gv-subject-pip{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
.gv-subject-name{flex:1;font-weight:500;font-size:14px;}
.gv-subject-grade{font-family:var(--font-display);font-size:22px;font-weight:600;}
.gv-subject-meta{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-top:4px;letter-spacing:0.04em;}
.gv-rows{margin-top:12px;border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:6px;}
.gv-row{display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;padding:6px 0;font-size:13px;}
.gv-row-grade{font-family:var(--font-display);font-weight:600;font-size:16px;}
.gv-row-meta{font-family:var(--font-mono);font-size:10px;color:var(--muted);}
.gv-row-actions{display:flex;gap:4px;}
.gv-row-actions button{background:none;border:none;color:var(--muted2);cursor:pointer;padding:2px 6px;font-size:14px;}
.gv-row-actions button:hover{color:var(--text);}
.gv-row-actions button.danger:hover{color:#c0392b;}
.gv-empty{padding:48px 20px;text-align:center;border:1px dashed var(--border2);border-radius:10px;background:var(--surface);color:var(--muted);}
.gv-empty-icon{font-size:32px;margin-bottom:10px;color:var(--muted2);}
/* v1.2 — semester grouping + archive controls */
.gv-sem-head{display:flex;align-items:center;gap:10px;margin:18px 0 8px;padding:0 2px;}
.gv-sem-label{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted2);}
.gv-sem-count{font-family:var(--font-mono);font-size:10px;color:var(--muted2);}
.gv-sem-btn{margin-inline-start:auto;background:none;border:1px solid var(--border2);color:var(--muted);font-family:var(--font-mono);font-size:9px;letter-spacing:0.08em;text-transform:uppercase;padding:5px 10px;border-radius:4px;cursor:pointer;transition:all 0.1s;}
.gv-sem-btn:hover{color:var(--text);border-color:var(--text);}
.gv-archived{opacity:0.55;}
.gv-archived .gv-subject{background:var(--surface2);}
.gv-arch-banner{margin:24px 0 10px;padding:10px 14px;background:var(--surface2);border-inline-start:3px solid var(--border2);font-family:var(--font-mono);font-size:11px;color:var(--muted);}
@media(max-width:480px){
  .gv-hero{flex-direction:column;align-items:stretch;}
  .gv-gpa-value{font-size:42px;}
}
`;

export default function GradesView({ state, dispatch, showFlash, session }) {
  const { t } = useTranslation();
  const mode = state.gradeMode || 'ib';
  const scale = scaleFor(mode, state.customScale);
  // v1.2 — archive-aware. `activeSubjects` drives the GPA and the primary
  // list; `archivedSubjects` rendered separately when the toggle is on.
  const allSubjects = Object.values(state.courses || {}).filter((s) => !s.deletedAt);
  const activeSubjects = allSubjects.filter((s) => !s.archivedAt);
  const archivedSubjects = allSubjects.filter((s) => !!s.archivedAt);
  const subjects = activeSubjects; // legacy name preserved for the Add-Grade modal
  const grades = (state.grades || []).filter((g) => !g.deletedAt);

  const [showArchived, setShowArchived] = useState(false);

  // GPA computed from active courses only — archived semesters should not
  // pull on the live average. The aggregates helper takes the full courses
  // map but we filter the input so archived rows are excluded from the
  // computation rather than being conditionally summed downstream.
  const activeCoursesMap = useMemo(() => {
    const map = {};
    for (const s of activeSubjects) map[s.id] = s;
    return map;
  }, [activeSubjects]);
  const subjectAggregates = useMemo(
    () => subjectsWithEffectiveGrades(activeCoursesMap, state.grades || []),
    [activeCoursesMap, state.grades],
  );
  const gpa = useMemo(() => calculateGPA(subjectAggregates, mode), [subjectAggregates, mode]);

  const [expandedId, setExpandedId] = useState(null);
  const [editing, setEditing] = useState(null); // grade row being edited
  const [showAdd, setShowAdd] = useState(false);

  function onAddClick(subjectId) {
    if (subjects.length === 0) {
      showFlash(t('gv.addCourseFirst'));
      return;
    }
    setEditing(null);
    setShowAdd({ subjectId: subjectId || subjects[0].id });
  }

  function saveGrade(payload) {
    const id = editing?.id || uid();
    if (editing) {
      dispatch({ type: 'EDIT_GRADE', id, ...payload });
    } else {
      dispatch({ type: 'ADD_GRADE', id, ...payload });
    }
    setShowAdd(false);
    setEditing(null);
    showFlash(editing ? t('gv.gradeUpdated') : t('gv.gradeAdded'));
    if (session) {
      outbox.enqueue('upsert_grade', {
        id, subjectId: payload.subjectId, grade: payload.grade, weight: payload.weight, date: payload.date,
      });
    }
  }

  function delGrade(id) {
    dispatch({ type: 'DELETE_GRADE', id });
    showFlash(t('gv.gradeDeleted'));
    if (session) outbox.enqueue('delete_grade', { id });
  }

  // v1.2 — semester archive/restore. Dispatch first for instant UI feedback,
  // then push to Supabase. Per-row sync failures don't roll back the local
  // change (LWW will reconcile on next pull). "Unscoped" semester (null)
  // can't be archived as a group — the user has to either tag those
  // courses with a semester first or archive them individually.
  function archiveSem(semester) {
    if (!semester) return;
    const stamp = new Date().toISOString();
    dispatch({ type: 'ARCHIVE_SEMESTER', semester, stamp });
    showFlash(t('gv.archived', { name: semester }));
    // Snapshot the courses map at enqueue time so a queued retry doesn't
    // miss courses added later — the batch is what the user intended now.
    if (session) outbox.enqueue('archive_semester', { courses: state.courses, semester });
  }
  function restoreSem(semester) {
    if (!semester) return;
    const stamp = new Date().toISOString();
    dispatch({ type: 'RESTORE_SEMESTER', semester, stamp });
    showFlash(t('gv.restored', { name: semester }));
    if (session) outbox.enqueue('restore_semester', { courses: state.courses, semester });
  }

  // Group subjects by semester for the archive controls. Subjects with no
  // semester land in a sentinel "(no semester)" bucket that doesn't get a
  // semester-archive button.
  function groupBySemester(list) {
    const groups = new Map();
    for (const s of list) {
      const key = s.semester || '__nosem__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    return Array.from(groups.entries()); // [[semester, subjects[]], ...]
  }
  const activeGroups = useMemo(() => groupBySemester(activeSubjects), [activeSubjects]);
  const archivedGroups = useMemo(() => groupBySemester(archivedSubjects), [archivedSubjects]);

  // Per-subject card render extracted into a helper so the active list
  // and the archived list can share it (archived gets a wrapper with
  // .gv-archived for the grayed-out styling). Keep grades sorted newest
  // first.
  function renderSubjectCard(s) {
    const own = grades.filter((g) => g.subjectId === s.id);
    const eff = subjectEffectiveGrade(own);
    const isOpen = expandedId === s.id;
    return (
      <div key={s.id} className="gv-subject">
        <div className="gv-subject-head" onClick={() => setExpandedId(isOpen ? null : s.id)}>
          <span className="gv-subject-pip" style={{ background: s.color || '#7a7570' }} />
          <div style={{ flex: 1 }}>
            <div className="gv-subject-name">{s.name}</div>
            <div className="gv-subject-meta">
              {t('gv.cr', { count: s.credits != null ? s.credits : 1 })}
              {s.semester ? ` · ${s.semester}` : ''}
              {` · ${t('gv.grades', { count: own.length })}`}
            </div>
          </div>
          <div className="gv-subject-grade">{eff == null ? '—' : eff.toFixed(2)}</div>
        </div>
        {isOpen && (
          <div className="gv-rows">
            {own.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 0' }}>{t('gv.noGradesCourse')}</div>
            )}
            {own.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((g) => (
              <div key={g.id} className="gv-row">
                <span>
                  <span className="gv-row-grade">{g.grade}</span>{' '}
                  <span className="gv-row-meta">× w={g.weight}</span>
                </span>
                <span className="gv-row-meta">{g.date || '—'}</span>
                <span />
                <span className="gv-row-actions">
                  <button onClick={() => { setEditing(g); setShowAdd({ subjectId: g.subjectId }); }} title={t('common.edit')}>✎</button>
                  <button className="danger" onClick={() => delGrade(g.id)} title={t('common.delete')}>×</button>
                </span>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <button className="btn-outline" onClick={(e) => { e.stopPropagation(); onAddClick(s.id); }}>{t('gv.addGradeTo', { name: s.name })}</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <style>{css}</style>
      <div className="gv-wrap">
        <div className="gv-hero">
          <div className="gv-gpa">
            <div className="gv-gpa-label">{mode === 'us' ? t('gv.gpa') : t('gv.ibAverage')}</div>
            <div className="gv-gpa-value">{gpa.toFixed(2)}</div>
            <div className="gv-gpa-scale" style={{ textTransform: 'uppercase' }}>
              {mode === 'custom' ? describeScale(scale, t) : mode === 'us' ? t('gv.usScale') : t('gv.ibScale')}
            </div>
          </div>
          <div className="gv-mode">
            <button className={mode === 'ib' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'ib' })}>IB</button>
            <button className={mode === 'us' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'us' })}>US</button>
            <button className={mode === 'custom' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'custom' })}>{t('gv.modeCustom')}</button>
          </div>
        </div>

        <div className="gv-toolbar">
          <button className="btn" onClick={() => onAddClick()} disabled={subjects.length === 0}>{t('gv.addGrade')}</button>
          {archivedSubjects.length > 0 && (
            <button className="btn-outline" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? t('gv.hideArchived', { count: archivedSubjects.length }) : t('gv.showArchived', { count: archivedSubjects.length })}
            </button>
          )}
        </div>

        {subjects.length === 0 && (
          <div className="gv-empty">
            <div className="gv-empty-icon">⌗</div>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>{t('gv.noCoursesTitle')}</div>
            <div style={{ fontSize: 13 }}>{t('gv.noCoursesBody')}</div>
          </div>
        )}

        {subjects.length > 0 && grades.length === 0 && (
          <div className="gv-empty">
            <div className="gv-empty-icon">⌬</div>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>{t('gv.noGradesTitle')}</div>
            <div style={{ fontSize: 13, marginBottom: 14 }}>{t('gv.noGradesBody')}</div>
            <button className="btn" onClick={() => onAddClick()}>{t('gv.addFirstGrade')}</button>
          </div>
        )}

        {/* Active courses grouped by semester. Each named-semester group
            gets an "Archive semester" button in its header. Subjects with
            no semester get a sentinel header without an archive button —
            the user has to either tag them with a semester first or
            archive them individually (deferred — modal action).  */}
        {activeGroups.map(([sem, list]) => (
          <div key={sem}>
            <div className="gv-sem-head">
              <span className="gv-sem-label">{sem === '__nosem__' ? t('gv.noSemester') : sem}</span>
              <span className="gv-sem-count">{t('gv.courses', { count: list.length })}</span>
              {sem !== '__nosem__' && (
                <button className="gv-sem-btn" onClick={() => archiveSem(sem)}>{t('gv.archiveSemester')}</button>
              )}
            </div>
            {list.map((s) => renderSubjectCard(s))}
          </div>
        ))}

        {/* Archived courses — toggle-gated. Grouped + grayed-out. Restore
            button per group. Per-course restore deferred (the per-semester
            UX covers the common case; one-off restore is rare). */}
        {showArchived && archivedGroups.length > 0 && (
          <>
            <div className="gv-arch-banner">{t('gv.archivedBanner')}</div>
            {archivedGroups.map(([sem, list]) => (
              <div key={`arch-${sem}`} className="gv-archived">
                <div className="gv-sem-head">
                  <span className="gv-sem-label">{sem === '__nosem__' ? t('gv.noSemester') : sem}</span>
                  <span className="gv-sem-count">{t('gv.courses', { count: list.length })}</span>
                  {sem !== '__nosem__' && (
                    <button className="gv-sem-btn" onClick={() => restoreSem(sem)}>{t('gv.restore')}</button>
                  )}
                </div>
                {list.map((s) => renderSubjectCard(s))}
              </div>
            ))}
          </>
        )}

        {showAdd && (
          <GradeEditModal
            mode={mode}
            scale={scale}
            subjects={subjects}
            initial={editing ? {
              subjectId: editing.subjectId, grade: editing.grade, weight: editing.weight, date: editing.date,
            } : { subjectId: showAdd.subjectId }}
            isEdit={!!editing}
            onSave={saveGrade}
            onDelete={editing ? () => { delGrade(editing.id); setShowAdd(false); setEditing(null); } : null}
            onClose={() => { setShowAdd(false); setEditing(null); }}
          />
        )}
      </div>
    </>
  );
}

function GradeEditModal({ mode, scale, subjects, initial, isEdit, onSave, onDelete, onClose }) {
  const { t } = useTranslation();
  const [subjectId, setSubjectId] = useState(initial.subjectId || subjects[0]?.id || '');
  const [grade, setGrade] = useState(initial.grade != null ? String(initial.grade) : '');
  const [weight, setWeight] = useState(initial.weight != null ? String(initial.weight) : '1');
  const [date, setDate] = useState(initial.date || new Date().toISOString().slice(0, 10));

  const placeholder = mode === 'custom'
    ? `${scale.min}\u2013${scale.max}`
    : mode === 'us' ? t('gv.phUs') : t('gv.phIb');

  function submit() {
    const gNum = parseFloat(grade);
    const wNum = parseFloat(weight);
    if (!subjectId) return;
    if (isNaN(gNum)) return;
    onSave({
      subjectId,
      grade: gNum,
      weight: isNaN(wNum) || wNum < 0 ? 1 : wNum,
      date: date || null,
    });
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isEdit ? t('gv.mEdit') : t('gv.mAdd')}</div>
        <div className="input-group">
          <div className="input-label">{t('gv.fCourse')}</div>
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="modal-grid">
          <div className="input-group">
            <div className="input-label">{mode === 'us' ? t('gv.fGradeUs') : t('gv.fGradeIb')}</div>
            <input type="number" step="0.01" min={scale.min} max={scale.max} placeholder={placeholder} value={grade} onChange={(e) => setGrade(e.target.value)} autoFocus />
          </div>
          <div className="input-group">
            <div className="input-label">{t('gv.fWeight')}</div>
            <input type="number" step="0.05" min="0" placeholder={t('gv.phWeight')} value={weight} onChange={(e) => setWeight(e.target.value)} />
          </div>
        </div>
        <div className="input-group">
          <div className="input-label">{t('gv.fDate')}</div>
          <input type="date" value={date || ''} onChange={(e) => setDate(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <button className="btn" onClick={submit}>{isEdit ? t('common.save') : t('gv.bAdd')}</button>
          <button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          {isEdit && onDelete && (
            <button className="btn-outline" style={{ marginLeft: 'auto', color: '#c0392b', borderColor: '#c0392b' }} onClick={onDelete}>{t('common.delete')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
