import { useMemo, useState } from 'react';
import * as outbox from '../../lib/outbox.js';

const css = `
.sv-wrap{padding:16px 24px 80px;max-width:780px;margin:0 auto;}
.sv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px;}
.sv-stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;}
.sv-stat-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;}
.sv-stat-value{font-size:22px;font-weight:600;font-family:var(--font-display);}
.sv-date-head{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;color:var(--muted2);text-transform:uppercase;margin:18px 0 6px;}
.sv-date-head:first-child{margin-top:0;}
.sv-item{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:13px;}
.sv-item-pip{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--border2);}
.sv-item-body{flex:1;min-width:0;}
.sv-item-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sv-item-meta{font-family:var(--font-mono);font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:0.04em;}
.sv-item-dur{font-family:var(--font-mono);font-size:11px;color:var(--muted);white-space:nowrap;}
.sv-focus{display:inline-flex;gap:3px;margin-left:8px;vertical-align:middle;}
.sv-focus-pip{width:5px;height:5px;border-radius:50%;background:var(--border2);}
.sv-focus-pip.on{background:var(--text);}
.sv-focus-row{display:flex;gap:6px;}
.sv-focus-row button{flex:1;padding:9px 0;font-family:var(--font-display);font-size:15px;font-weight:600;cursor:pointer;border-radius:8px;border:1px solid var(--border2);background:transparent;color:var(--muted);transition:all 120ms var(--ease-page-turn,ease);}
.sv-focus-row button.on{border-color:var(--text);background:var(--text);color:var(--bg);}
.sv-item-actions{display:flex;gap:4px;}
.sv-item-actions button{background:none;border:none;color:var(--muted2);cursor:pointer;padding:2px 6px;font-size:14px;}
.sv-item-actions button:hover{color:var(--text);}
.sv-item-actions button.danger:hover{color:#c0392b;}
.sv-empty{padding:48px 20px;text-align:center;border:1px dashed var(--border2);border-radius:10px;background:var(--surface);color:var(--muted);}
`;

function fmtDateHeader(iso) {
  const d = new Date(iso + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'TODAY';
  if (sameDay(d, yesterday)) return 'YESTERDAY';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined }).toUpperCase();
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function SessionsView({ state, dispatch, showFlash, session }) {
  const sessions = useMemo(
    () => (state.studySessions || [])
      .filter((s) => !s.deletedAt)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')),
    [state.studySessions],
  );

  // Group by date (YYYY-MM-DD).
  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      const key = (s.startedAt || '').slice(0, 10) || 'unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    return Array.from(map.entries());
  }, [sessions]);

  // Totals
  const total = sessions.reduce((a, s) => a + (Number(s.durationMinutes) || 0), 0);
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayTotal = sessions.filter((s) => (s.startedAt || '').startsWith(todayKey)).reduce((a, s) => a + (Number(s.durationMinutes) || 0), 0);
  // Last 7 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0, 0, 0, 0);
  const weekTotal = sessions.filter((s) => s.startedAt && new Date(s.startedAt) >= cutoff).reduce((a, s) => a + (Number(s.durationMinutes) || 0), 0);

  const [editing, setEditing] = useState(null);

  function delSession(id) {
    dispatch({ type: 'DELETE_SESSION', id });
    showFlash('Session deleted');
    if (session) outbox.enqueue('delete_session', { id });
  }

  return (
    <>
      <style>{css}</style>
      <div className="sv-wrap">
        <div className="sv-stats">
          <div className="sv-stat"><div className="sv-stat-label">Today</div><div className="sv-stat-value">{(todayTotal / 60).toFixed(1)}h</div></div>
          <div className="sv-stat"><div className="sv-stat-label">Last 7 days</div><div className="sv-stat-value">{(weekTotal / 60).toFixed(1)}h</div></div>
          <div className="sv-stat"><div className="sv-stat-label">All-time sessions</div><div className="sv-stat-value">{sessions.length}</div></div>
          <div className="sv-stat"><div className="sv-stat-label">All-time hours</div><div className="sv-stat-value">{(total / 60).toFixed(1)}h</div></div>
        </div>

        {sessions.length === 0 && (
          <div className="sv-empty">
            <div style={{ fontSize: 32, marginBottom: 10, color: 'var(--muted2)' }}>≡</div>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text)' }}>No sessions logged yet</div>
            <div style={{ fontSize: 13 }}>Finish a Pomodoro and tap Save to start tracking.</div>
          </div>
        )}

        {grouped.map(([dateKey, list]) => {
          const dayTotal = list.reduce((a, s) => a + (Number(s.durationMinutes) || 0), 0);
          return (
            <div key={dateKey}>
              <div className="sv-date-head">
                {fmtDateHeader(dateKey)} · {(dayTotal / 60).toFixed(1)}h
              </div>
              {list.map((s) => {
                const course = s.subjectId ? state.courses[s.subjectId] : null;
                return (
                  <div key={s.id} className="sv-item">
                    <span className="sv-item-pip" style={{ background: course?.color || 'var(--border2)' }} />
                    <div className="sv-item-body">
                      <div className="sv-item-title">
                        {course?.name || s.notes || 'General study'}
                        {s.aiSessionSummary && (
                          <span
                            title="AI debrief"
                            style={{
                              marginLeft: 6,
                              fontFamily: 'var(--font-mono)',
                              fontSize: 9,
                              letterSpacing: '0.08em',
                              padding: '1px 5px',
                              borderRadius: 4,
                              border: '1px solid var(--border2)',
                              color: 'var(--muted)',
                              verticalAlign: 'middle',
                            }}
                          >
                            AI
                          </span>
                        )}
                      </div>
                      <div className="sv-item-meta">
                        {fmtTime(s.startedAt)}
                        {course && s.notes ? ` · ${s.notes}` : ''}
                        {s.focusRating != null && (
                          <span className="sv-focus" title={`Focus ${s.focusRating}/5`} aria-label={`Focus ${s.focusRating} of 5`}>
                            {[1, 2, 3, 4, 5].map((n) => (
                              <span key={n} className={'sv-focus-pip' + (n <= s.focusRating ? ' on' : '')} />
                            ))}
                          </span>
                        )}
                      </div>
                      {s.aiSessionSummary && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                          {s.aiSessionSummary}
                          {s.aiComprehension != null ? ` · ${s.aiComprehension}/5` : ''}
                        </div>
                      )}
                    </div>
                    <span className="sv-item-dur">{s.durationMinutes}m</span>
                    <span className="sv-item-actions">
                      <button onClick={() => setEditing(s)} title="Edit">✎</button>
                      <button className="danger" onClick={() => delSession(s.id)} title="Delete">×</button>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}

        {editing && (
          <SessionEditModal
            session={editing}
            courses={Object.values(state.courses).filter((c) => !c.deletedAt)}
            onClose={() => setEditing(null)}
            onSave={(patch) => {
              dispatch({ type: 'EDIT_SESSION', id: editing.id, ...patch });
              setEditing(null);
              showFlash('Session updated');
              if (session) outbox.enqueue('update_session', { id: editing.id, ...patch });
            }}
          />
        )}
      </div>
    </>
  );
}

function SessionEditModal({ session, courses, onClose, onSave }) {
  const [subjectId, setSubjectId] = useState(session.subjectId || '');
  const [duration, setDuration] = useState(String(session.durationMinutes));
  const [notes, setNotes] = useState(session.notes || '');
  const [focus, setFocus] = useState(session.focusRating ?? null);

  function submit() {
    const d = parseInt(duration, 10);
    if (isNaN(d) || d < 1) return;
    onSave({
      subjectId: subjectId || null,
      durationMinutes: d,
      notes: notes.trim() || null,
      focusRating: focus,
    });
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Edit session</div>
        <div className="input-group">
          <div className="input-label">Course</div>
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">General study</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="input-group">
          <div className="input-label">Duration (minutes)</div>
          <input type="number" min="1" max="1440" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
        <div className="input-group">
          <div className="input-label">Notes</div>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </div>
        <div className="input-group">
          <div className="input-label">Focus quality (optional)</div>
          <div className="sv-focus-row">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={focus === n ? 'on' : ''}
                aria-pressed={focus === n}
                onClick={() => setFocus(focus === n ? null : n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="btn" onClick={submit}>Save</button>
          <button className="btn-outline" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
