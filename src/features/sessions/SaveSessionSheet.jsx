import { useState } from 'react';

/**
 * Raised after a focus phase ends. The user explicitly opts in to logging
 * the session — per the brief, "don't log anything until the user taps Save."
 */
const FOCUS_LABELS = ['', 'Scattered', 'Distracted', 'Okay', 'Focused', 'Locked in'];

export default function SaveSessionSheet({ pending, courses, onSave, onClose }) {
  const [subjectId, setSubjectId] = useState('');
  const [duration, setDuration] = useState(String(pending.durationMinutes));
  const [notes, setNotes] = useState(pending.task || '');
  // v1.3 (BUG-22) — optional focus quality. null = skipped (the default).
  const [focus, setFocus] = useState(null);

  function submit() {
    const d = parseInt(duration, 10);
    if (isNaN(d) || d < 1) return;
    onSave({
      subjectId: subjectId || null,
      durationMinutes: d,
      notes: notes.trim() || null,
      startedAt: pending.startedAt,
      focusRating: focus,
    });
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Save session?</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
          Focus session finished. Log it so it counts toward your study totals.
        </div>

        <div className="input-group">
          <div className="input-label">Course (optional)</div>
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">General study</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="modal-grid">
          <div className="input-group">
            <div className="input-label">Duration (minutes)</div>
            <input type="number" min="1" max="1440" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <div className="input-group">
            <div className="input-label">Started at</div>
            <input
              type="text"
              readOnly
              value={pending.startedAt
                ? new Date(pending.startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                : ''}
              style={{ background: 'var(--surface2)' }}
            />
          </div>
        </div>

        <div className="input-group">
          <div className="input-label">Notes (optional)</div>
          <input type="text" placeholder="What did you work on?" value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus />
        </div>

        <div className="input-group">
          <div className="input-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>How focused were you? (optional)</span>
            {focus != null && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.04em' }}>
                {FOCUS_LABELS[focus]}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[1, 2, 3, 4, 5].map((n) => {
              const active = focus === n;
              return (
                <button
                  key={n}
                  type="button"
                  aria-label={`Focus ${n} — ${FOCUS_LABELS[n]}`}
                  aria-pressed={active}
                  onClick={() => setFocus(active ? null : n)}
                  style={{
                    flex: 1,
                    padding: '9px 0',
                    fontFamily: 'var(--font-display)',
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: 'pointer',
                    borderRadius: 8,
                    border: active ? '1px solid var(--text)' : '1px solid var(--border2)',
                    background: active ? 'var(--text)' : 'transparent',
                    color: active ? 'var(--bg)' : 'var(--muted)',
                    transition: 'all 120ms var(--ease-page-turn, ease)',
                  }}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="btn" onClick={submit}>Save session</button>
          <button className="btn-outline" onClick={onClose}>Discard</button>
        </div>
      </div>
    </div>
  );
}
