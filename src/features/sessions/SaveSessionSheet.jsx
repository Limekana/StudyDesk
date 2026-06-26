import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { analyseStudySession } from '../../lib/aiStudyDebrief.js';

export default function SaveSessionSheet({ pending, courses, onSave, onClose, canDebrief = false }) {
  const { t } = useTranslation();
  // Focus labels are looked up per-rating via t('ss.focus{n}') (1–5); index 0 is unused.
  const focusLabel = (n) => (n >= 1 && n <= 5 ? t(`ss.focus${n}`) : '');
  const [subjectId, setSubjectId] = useState('');
  const [duration, setDuration] = useState(String(pending.durationMinutes));
  const [notes, setNotes] = useState(pending.task || '');
  // v1.3 (BUG-22) — optional focus quality. null = skipped (the default).
  const [focus, setFocus] = useState(null);
  // v1.4 — optional AI debrief. The user types what they covered; the cloud
  // Gemini proxy extracts structured fields. All null when skipped.
  const [debriefText, setDebriefText] = useState('');
  const [analysing, setAnalysing] = useState(false);
  const [debrief, setDebrief] = useState(null);
  const [debriefError, setDebriefError] = useState(false);

  async function runAnalyse() {
    const t = debriefText.trim();
    if (!t || analysing) return;
    setAnalysing(true);
    setDebriefError(false);
    const result = await analyseStudySession(t);
    setAnalysing(false);
    if (result) setDebrief(result);
    else setDebriefError(true);
  }

  function submit() {
    const d = parseInt(duration, 10);
    if (isNaN(d) || d < 1) return;
    onSave({
      subjectId: subjectId || null,
      durationMinutes: d,
      notes: notes.trim() || null,
      startedAt: pending.startedAt,
      focusRating: focus,
      // Only attach AI fields when an analysis was actually produced.
      ...(debrief
        ? {
            aiDebriefRaw: debriefText.trim().slice(0, 1000),
            aiSubjectCovered: debrief.subjectCovered || null,
            aiComprehension: debrief.comprehension,
            aiConfusionFlags: debrief.confusionFlags.length ? debrief.confusionFlags : null,
            aiSessionSummary: debrief.sessionSummary || null,
          }
        : {}),
    });
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('ss.title')}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
          {t('ss.intro')}
        </div>

        <div className="input-group">
          <div className="input-label">{t('ss.fCourse')}</div>
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">{t('ss.generalStudy')}</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="modal-grid">
          <div className="input-group">
            <div className="input-label">{t('ss.fDuration')}</div>
            <input type="number" min="1" max="1440" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <div className="input-group">
            <div className="input-label">{t('ss.fStarted')}</div>
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
          <div className="input-label">{t('ss.fNotes')}</div>
          <input type="text" placeholder={t('ss.phNotes')} value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus />
        </div>

        <div className="input-group">
          <div className="input-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>{t('ss.fFocus')}</span>
            {focus != null && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', letterSpacing: '0.04em' }}>
                {focusLabel(focus)}
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
                  aria-label={`${focusLabel(n)} (${n}/5)`}
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

        {canDebrief && (
          <div className="input-group">
            <div className="input-label">{t('ss.fCover')}</div>
            {debrief ? (
              <div
                style={{
                  border: '1px solid var(--border2)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 13,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {debrief.subjectCovered && (
                  <div><strong>{t('ss.subject')}</strong> {debrief.subjectCovered}</div>
                )}
                {debrief.comprehension != null && (
                  <div>
                    <strong>{t('ss.comprehension')}</strong>{' '}
                    {'●'.repeat(debrief.comprehension) + '○'.repeat(5 - debrief.comprehension)} ({debrief.comprehension}/5)
                  </div>
                )}
                {debrief.confusionFlags.length > 0 && (
                  <div><strong>{t('ss.confusion')}</strong> {debrief.confusionFlags.join(', ')}</div>
                )}
                {debrief.sessionSummary && (
                  <div style={{ color: 'var(--muted)' }}>{debrief.sessionSummary}</div>
                )}
                <button
                  type="button"
                  className="btn-outline"
                  style={{ alignSelf: 'flex-start', marginTop: 2, fontSize: 12, padding: '4px 10px' }}
                  onClick={() => { setDebrief(null); setDebriefError(false); }}
                >
                  {t('ss.redo')}
                </button>
              </div>
            ) : (
              <>
                <textarea
                  rows={2}
                  placeholder={t('ss.phCover')}
                  value={debriefText}
                  onChange={(e) => setDebriefText(e.target.value)}
                  style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn-outline"
                    style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={runAnalyse}
                    disabled={analysing || !debriefText.trim()}
                  >
                    {analysing ? t('ss.analysing') : t('ss.analyse')}
                  </button>
                  {debriefError && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {t('ss.analyseFail')}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="btn" onClick={submit}>{t('ss.saveBtn')}</button>
          <button className="btn-outline" onClick={onClose}>{t('ss.discard')}</button>
        </div>
      </div>
    </div>
  );
}
