import { useState } from 'react';

/**
 * Raised after a focus phase ends. The user explicitly opts in to logging
 * the session — per the brief, "don't log anything until the user taps Save."
 */
export default function SaveSessionSheet({ pending, courses, onSave, onClose }) {
  const [subjectId, setSubjectId] = useState('');
  const [duration, setDuration] = useState(String(pending.durationMinutes));
  const [notes, setNotes] = useState(pending.task || '');

  function submit() {
    const d = parseInt(duration, 10);
    if (isNaN(d) || d < 1) return;
    onSave({
      subjectId: subjectId || null,
      durationMinutes: d,
      notes: notes.trim() || null,
      startedAt: pending.startedAt,
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

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="btn" onClick={submit}>Save session</button>
          <button className="btn-outline" onClick={onClose}>Discard</button>
        </div>
      </div>
    </div>
  );
}
