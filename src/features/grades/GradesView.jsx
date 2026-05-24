import { useMemo, useState } from 'react';
import { calculateGPA, subjectEffectiveGrade, subjectsWithEffectiveGrades } from '../../lib/gpa.js';
import * as sync from '../../lib/sync.js';

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
@media(max-width:480px){
  .gv-hero{flex-direction:column;align-items:stretch;}
  .gv-gpa-value{font-size:42px;}
}
`;

export default function GradesView({ state, dispatch, showFlash, session }) {
  const mode = state.gradeMode || 'ib';
  const subjects = Object.values(state.courses || {}).filter((s) => !s.deletedAt);
  const grades = (state.grades || []).filter((g) => !g.deletedAt);

  const subjectAggregates = useMemo(
    () => subjectsWithEffectiveGrades(state.courses || {}, state.grades || []),
    [state.courses, state.grades],
  );
  const gpa = useMemo(() => calculateGPA(subjectAggregates, mode), [subjectAggregates, mode]);

  const [expandedId, setExpandedId] = useState(null);
  const [editing, setEditing] = useState(null); // grade row being edited
  const [showAdd, setShowAdd] = useState(false);

  function onAddClick(subjectId) {
    if (subjects.length === 0) {
      showFlash('Add a course first');
      return;
    }
    setEditing(null);
    setShowAdd({ subjectId: subjectId || subjects[0].id });
  }

  async function saveGrade(payload) {
    const id = editing?.id || uid();
    if (editing) {
      dispatch({ type: 'EDIT_GRADE', id, ...payload });
    } else {
      dispatch({ type: 'ADD_GRADE', id, ...payload });
    }
    setShowAdd(false);
    setEditing(null);
    showFlash(editing ? 'Grade updated' : 'Grade added');
    if (session) {
      try {
        await sync.upsertGrade({ id, subjectId: payload.subjectId, grade: payload.grade, weight: payload.weight, date: payload.date });
      } catch (e) {
        showFlash('Sync failed: ' + e.message);
      }
    }
  }

  async function delGrade(id) {
    dispatch({ type: 'DELETE_GRADE', id });
    showFlash('Grade deleted');
    if (session) {
      try { await sync.deleteGrade(id); } catch (e) { showFlash('Sync failed: ' + e.message); }
    }
  }

  return (
    <>
      <style>{css}</style>
      <div className="gv-wrap">
        <div className="gv-hero">
          <div className="gv-gpa">
            <div className="gv-gpa-label">{mode === 'ib' ? 'IB Average' : 'GPA'}</div>
            <div className="gv-gpa-value">{gpa.toFixed(2)}</div>
            <div className="gv-gpa-scale">{mode === 'ib' ? 'WEIGHTED 1–7 SCALE' : '4.0 SCALE'}</div>
          </div>
          <div className="gv-mode">
            <button className={mode === 'ib' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'ib' })}>IB</button>
            <button className={mode === 'us' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'us' })}>US</button>
          </div>
        </div>

        <div className="gv-toolbar">
          <button className="btn" onClick={() => onAddClick()} disabled={subjects.length === 0}>+ Add Grade</button>
        </div>

        {subjects.length === 0 && (
          <div className="gv-empty">
            <div className="gv-empty-icon">⌗</div>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>No courses yet</div>
            <div style={{ fontSize: 13 }}>Add a course from the sidebar to start tracking grades.</div>
          </div>
        )}

        {subjects.length > 0 && grades.length === 0 && (
          <div className="gv-empty">
            <div className="gv-empty-icon">⌬</div>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>No grades yet</div>
            <div style={{ fontSize: 13, marginBottom: 14 }}>Log a grade and your GPA will update.</div>
            <button className="btn" onClick={() => onAddClick()}>+ Add your first grade</button>
          </div>
        )}

        {subjects.map((s) => {
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
                    {s.credits != null ? `${s.credits} CR` : '1 CR'}
                    {s.semester ? ` · ${s.semester}` : ''}
                    {` · ${own.length} grade${own.length === 1 ? '' : 's'}`}
                  </div>
                </div>
                <div className="gv-subject-grade">{eff == null ? '—' : eff.toFixed(2)}</div>
              </div>
              {isOpen && (
                <div className="gv-rows">
                  {own.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 0' }}>No grades for this course yet.</div>
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
                        <button onClick={() => { setEditing(g); setShowAdd({ subjectId: g.subjectId }); }} title="Edit">✎</button>
                        <button className="danger" onClick={() => delGrade(g.id)} title="Delete">×</button>
                      </span>
                    </div>
                  ))}
                  <div style={{ marginTop: 8 }}>
                    <button className="btn-outline" onClick={(e) => { e.stopPropagation(); onAddClick(s.id); }}>+ Add grade to {s.name}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {showAdd && (
          <GradeEditModal
            mode={mode}
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

function GradeEditModal({ mode, subjects, initial, isEdit, onSave, onDelete, onClose }) {
  const [subjectId, setSubjectId] = useState(initial.subjectId || subjects[0]?.id || '');
  const [grade, setGrade] = useState(initial.grade != null ? String(initial.grade) : '');
  const [weight, setWeight] = useState(initial.weight != null ? String(initial.weight) : '1');
  const [date, setDate] = useState(initial.date || new Date().toISOString().slice(0, 10));

  const placeholder = mode === 'ib' ? 'e.g. 6.5 (1–7)' : 'e.g. 87 (0–100)';

  function submit() {
    const gNum = parseFloat(grade);
    const wNum = parseFloat(weight);
    if (!subjectId) return;
    if (isNaN(gNum)) return;
    onSave({
      subjectId,
      grade: gNum,
      weight: isNaN(wNum) ? 1 : wNum,
      date: date || null,
    });
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{isEdit ? 'Edit Grade' : 'Add Grade'}</div>
        <div className="input-group">
          <div className="input-label">Course</div>
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="modal-grid">
          <div className="input-group">
            <div className="input-label">Grade ({mode === 'ib' ? '1–7' : '0–100'})</div>
            <input type="number" step="0.01" placeholder={placeholder} value={grade} onChange={(e) => setGrade(e.target.value)} autoFocus />
          </div>
          <div className="input-group">
            <div className="input-label">Weight</div>
            <input type="number" step="0.05" min="0" placeholder="e.g. 0.3" value={weight} onChange={(e) => setWeight(e.target.value)} />
          </div>
        </div>
        <div className="input-group">
          <div className="input-label">Date</div>
          <input type="date" value={date || ''} onChange={(e) => setDate(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <button className="btn" onClick={submit}>{isEdit ? 'Save' : 'Add Grade'}</button>
          <button className="btn-outline" onClick={onClose}>Cancel</button>
          {isEdit && onDelete && (
            <button className="btn-outline" style={{ marginLeft: 'auto', color: '#c0392b', borderColor: '#c0392b' }} onClick={onDelete}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}
