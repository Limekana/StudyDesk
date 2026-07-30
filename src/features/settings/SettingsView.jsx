import { useState, useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage, SUPPORTED_LANGS, LANGUAGE_NAMES } from '../../i18n/index.js';
import { useScrollSelectedIntoView } from '../../lib/useScrollSelectedIntoView.js';
import { supabase } from '../../lib/supabase.js';
import { setGuestMode } from '../../lib/guestMode.js';
import PeriodHistory from '../grades/PeriodHistory.jsx';
import * as sync from '../../lib/sync.js';
import * as outbox from '../../lib/outbox.js';
import { downloadExport, deleteAccount } from '../../lib/dataRights.js';
import { useConfirm } from '../../lib/useConfirm.js';
import { avatarInitials } from '../../lib/avatarInitials.js';
import { GuestAvatar } from '../../lib/avatar.jsx';
import pkg from '../../../package.json';

const css = `
.sv2-wrap{padding:16px 24px 80px;max-width:680px;margin:0 auto;}
.sv2-section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:14px;}
.sv2-section-title{font-family:var(--font-mono);font-size:10px;letter-spacing:0.18em;color:var(--muted2);text-transform:uppercase;margin-bottom:14px;}

/* Language switcher grid (v1.5.1) */
.sv2-lang-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:184px;overflow-y:auto;overscroll-behavior:contain;}
.sv2-lang-btn{font-family:var(--font-display);font-size:14px;color:var(--text);background:var(--bg);border:1px solid var(--border2);border-radius:9px;padding:11px 10px;cursor:pointer;text-align:start;transition:border-color .15s,background .15s;}
.sv2-lang-btn:hover{border-color:var(--muted2);}
.sv2-lang-btn--on{border-color:var(--accent,#2e7d52);background:color-mix(in srgb,var(--accent,#2e7d52) 8%,transparent);color:var(--accent,#2e7d52);font-weight:600;}

/* Account hero */
.sv2-hero{display:flex;align-items:center;gap:14px;}
.sv2-avatar{width:52px;height:52px;min-width:52px;border-radius:50%;border:1px solid var(--border2);background:var(--bg);color:var(--text);font-family:var(--font-display);font-size:21px;font-weight:600;display:flex;align-items:center;justify-content:center;text-transform:uppercase;}
.sv2-hero-info{min-width:0;flex:1;}
.sv2-hero-name{font-family:var(--font-display);font-size:18px;font-weight:600;line-height:1.1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sv2-hero-status{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12px;color:var(--muted);}
.sv2-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;}

/* Stat chips */
.sv2-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:6px;}
.sv2-stat{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;text-align:center;}
.sv2-stat-num{font-family:var(--font-display);font-size:22px;font-weight:600;line-height:1;}
.sv2-stat-lbl{font-family:var(--font-mono);font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted2);margin-top:5px;}

.sv2-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;font-size:14px;}
.sv2-row + .sv2-row{border-top:1px solid var(--border);}
.sv2-row-label{color:var(--muted);font-size:13px;}
.sv2-row-value{font-size:13px;color:var(--text);text-align:end;display:flex;align-items:center;gap:6px;}
.sv2-mode{display:inline-flex;border:1px solid var(--border2);border-radius:6px;overflow:hidden;}
.sv2-mode button{background:transparent;border:none;padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;color:var(--muted);}
.sv2-mode button.active{background:var(--text);color:var(--bg);}
.sv2-action{margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;}
.sv2-danger{margin-top:20px;padding-top:16px;border-top:1px solid var(--danger-border);}
.sv2-danger-title{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--danger);margin-bottom:6px;}
.sv2-danger-btn{margin-top:12px;color:var(--danger);border-color:var(--danger-border);}
.sv2-danger-btn:active{background:var(--danger-bg);}
.sv2-signout{background:var(--danger);color:var(--danger-on);border:none;padding:10px 18px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;border-radius:6px;font-weight:500;}
.sv2-signout:hover{opacity:0.85;}
.sv2-signin{background:var(--text);color:var(--bg);border:none;padding:10px 18px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;border-radius:6px;font-weight:500;}
.sv2-signin:hover{opacity:0.88;}
.sv2-note{font-size:12px;color:var(--muted);margin-top:12px;line-height:1.55;}

/* Technical details — quiet, monospace, clearly secondary */
.sv2-tech{margin-top:4px;}
.sv2-tech summary{font-family:var(--font-mono);font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--muted2);cursor:pointer;list-style:none;padding:4px 0;}
.sv2-tech summary::-webkit-details-marker{display:none;}
.sv2-tech summary::before{content:"▸ ";color:var(--muted2);}
.sv2-tech[open] summary::before{content:"▾ ";}
.sv2-tech-grid{margin-top:8px;display:flex;flex-direction:column;gap:6px;}
.sv2-tech-item{display:flex;justify-content:space-between;gap:10px;font-family:var(--font-mono);font-size:11px;color:var(--muted);}
.sv2-tech-item span:last-child{color:var(--muted2);text-align:end;word-break:break-all;}
.sv2-link{color:var(--muted);text-decoration:underline;}
`;

function fmtTime(iso, t, lang) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return t('settings.justNow');
  if (diff < 3600) return t('settings.minAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('settings.hAgo', { n: Math.floor(diff / 3600) });
  return d.toLocaleDateString(lang || 'en', { day: 'numeric', month: 'short' });
}

export default function SettingsView({ state, dispatch, showFlash, session }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const currentLang = (i18n.language || 'en').split('-')[0];
  const langRef = useScrollSelectedIntoView();
  const lang = currentLang; // for locale-aware date formatting in fmtTime
  const [pulling, setPulling] = useState(false);
  const [lastPullAt, setLastPullAt] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  const [draining, setDraining] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const outboxStatus = useSyncExternalStore(
    outbox.subscribe,
    outbox.getStatus,
    outbox.getStatus,
  );

  const onRetryNow = useCallback(async () => {
    setDraining(true);
    try {
      const remaining = await outbox.drain();
      showFlash(remaining === 0 ? t('settings.queueDrained') : t('settings.stillPending', { count: remaining }));
    } finally {
      setDraining(false);
    }
  }, [showFlash, t]);

  const subjects = Object.values(state.courses || {}).filter((c) => !c.deletedAt);
  const grades = (state.grades || []).filter((g) => !g.deletedAt);
  const sessions = (state.studySessions || []).filter((s) => !s.deletedAt);

  const mode = state.gradeMode || 'ib';

  const onSignOut = useCallback(async () => {
    if (!(await confirm(t('settings.signOutConfirm')))) return;
    setSigningOut(true);
    try {
      // Drain-then-wipe order preserved from the v1.1.1 / AUDIT-SD-FSG-2 work:
      // clear the outbox + reset reducer state BEFORE the auth round-trip so a
      // queued retry can't replay user A's writes against the next user, and a
      // shared device shows no residue.
      outbox.clear();
      dispatch({ type: 'RESET_AFTER_SIGNOUT' });
      setGuestMode(true);
      window.dispatchEvent(new CustomEvent('studydesk:guest-mode-changed'));
      await supabase.auth.signOut();
      showFlash(t('settings.signedOutLocal'));
    } catch (e) {
      showFlash(t('settings.signOutFailed', { msg: e.message }));
    } finally {
      setSigningOut(false);
    }
  }, [confirm, showFlash, dispatch, t]);

  // ── GDPR Art. 20 — portability ─────────────────────────────────────────────
  const onExport = useCallback(() => {
    try {
      const name = downloadExport(state, session);
      showFlash(t('settings.exportDone', { name }));
    } catch (e) {
      showFlash(t('settings.exportFailed', { msg: e.message }));
    }
  }, [state, session, showFlash, t]);

  // ── GDPR Art. 17 — erasure ─────────────────────────────────────────────────
  // Two confirmations, because this is irreversible and there is no recovery
  // window: the account row is gone and every cascade has fired.
  const onDeleteAccount = useCallback(async () => {
    if (!(await confirm(t('settings.deleteAccountConfirm1')))) return;
    if (!(await confirm(t('settings.deleteAccountConfirm2')))) return;
    setDeleting(true);
    try {
      await deleteAccount({
        clearLocal: async () => {
          outbox.clear();
          dispatch({ type: 'RESET_AFTER_SIGNOUT' });
          for (const k of ['studydesk-v1', 'studydesk-needs-initial-push',
                           'studydesk-onboarded', 'studydesk-grade-mode', 'sd-timer']) {
            try { localStorage.removeItem(k); } catch { /* private mode */ }
          }
          setGuestMode(true);
          window.dispatchEvent(new CustomEvent('studydesk:guest-mode-changed'));
        },
      });
      showFlash(t('settings.deleteAccountDone'));
    } catch (e) {
      showFlash(t('settings.deleteAccountFailed', { msg: e.message }));
    } finally {
      setDeleting(false);
    }
  }, [confirm, dispatch, showFlash, t]);

  // v1.3.1 — guests sign in from here now that the topbar button is gone.
  // Flipping guestMode off routes the app back to AuthGate.
  const onSignIn = useCallback(() => {
    setGuestMode(false);
    window.dispatchEvent(new CustomEvent('studydesk:guest-mode-changed'));
  }, []);

  const onPullNow = useCallback(async () => {
    if (!session) { showFlash(t('settings.notSignedIn')); return; }
    setPulling(true);
    try {
      const remote = await sync.pullAllStudyData();
      dispatch({ type: 'MERGE_REMOTE', remote });
      setLastPullAt(new Date().toISOString());
      showFlash(t('settings.syncedSummary', { subjects: remote.subjects.length, grades: remote.grades.length, sessions: remote.sessions.length }));
    } catch (e) {
      showFlash(t('settings.pullFailed', { msg: e.message }));
    } finally {
      setPulling(false);
    }
  }, [session, dispatch, showFlash, t]);

  const userEmail = session?.user?.email || '—';
  const userId = session?.user?.id;
  const userIdShort = userId ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : '—';
  const provider = session?.user?.app_metadata?.provider || 'email';
  const appVersion = pkg.version;

  return (
    <>
      <style>{css}</style>
      <div className="sv2-wrap">
        {/* ── Account hero ── */}
        <div className="sv2-section">
          <div className="sv2-hero">
            <div className="sv2-avatar">{avatarInitials(session) ?? <GuestAvatar/>}</div>
            <div className="sv2-hero-info">
              <div className="sv2-hero-name">{session ? userEmail : t('settings.guest')}</div>
              <div className="sv2-hero-status">
                <span className="sv2-dot" style={{ background: session ? '#2e7d52' : 'var(--muted2)' }} />
                {session ? t('settings.signedInProvider', { provider }) : t('settings.localOnly')}
              </div>
            </div>
          </div>
          <div className="sv2-action">
            {session ? (
              <button className="sv2-signout" onClick={onSignOut} disabled={signingOut}>
                {signingOut ? t('settings.signingOut') : t('settings.signOut')}
              </button>
            ) : (
              <button className="sv2-signin" onClick={onSignIn}>{t('settings.signInToSync')}</button>
            )}
          </div>
          {!session && (
            <div className="sv2-note">
              {t('settings.guestNote')}
            </div>
          )}
        </div>

        {/* ── Language ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.language')}</div>
          <div className="sv2-lang-grid" ref={langRef}>
            {SUPPORTED_LANGS.map((code) => (
              <button
                key={code}
                className={`sv2-lang-btn${currentLang === code ? ' sv2-lang-btn--on' : ''}`}
                onClick={() => setLanguage(code)}
                aria-pressed={currentLang === code}
              >
                {LANGUAGE_NAMES[code]}
              </button>
            ))}
          </div>
        </div>

        {/* ── Cloud sync ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.cloudSync')}</div>
          <div className="sv2-stats">
            <div className="sv2-stat"><div className="sv2-stat-num">{subjects.length}</div><div className="sv2-stat-lbl">{t('settings.subjects')}</div></div>
            <div className="sv2-stat"><div className="sv2-stat-num">{grades.length}</div><div className="sv2-stat-lbl">{t('settings.gradesLbl')}</div></div>
            <div className="sv2-stat"><div className="sv2-stat-num">{sessions.length}</div><div className="sv2-stat-lbl">{t('settings.sessionsLbl')}</div></div>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.connection')}</span>
            <span className="sv2-row-value">
              <span className="sv2-dot" style={{ background: session ? '#2e7d52' : 'var(--muted2)' }} />
              {session ? t('settings.realtimeActive') : t('settings.offlineLocal')}
            </span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.pendingQueue')}</span>
            <span className="sv2-row-value">
              {outboxStatus.pending === 0 ? (
                <><span className="sv2-dot" style={{ background: '#2e7d52' }} />{t('settings.allSynced')}</>
              ) : (
                <>
                  <span className="sv2-dot" style={{ background: outboxStatus.stuck > 0 ? 'var(--danger)' : '#d4860a' }} />
                  {t('settings.pendingCount', { count: outboxStatus.pending })}{outboxStatus.stuck > 0 && ` ${t('settings.stuck', { count: outboxStatus.stuck })}`}
                </>
              )}
            </span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.lastPush')}</span>
            <span className="sv2-row-value">{fmtTime(outboxStatus.lastSuccessAt, t, lang)}</span>
          </div>
          {lastPullAt && (
            <div className="sv2-row">
              <span className="sv2-row-label">{t('settings.lastPull')}</span>
              <span className="sv2-row-value">{fmtTime(lastPullAt, t, lang)}</span>
            </div>
          )}
          {outboxStatus.lastError && (
            <div className="sv2-row">
              <span className="sv2-row-label">{t('settings.lastError')}</span>
              <span className="sv2-row-value" style={{ color: 'var(--danger)', fontSize: 11 }}>{outboxStatus.lastError}</span>
            </div>
          )}
          {session && (
            <div className="sv2-action">
              <button className="btn-outline" onClick={onPullNow} disabled={pulling}>
                {pulling ? t('settings.pulling') : t('settings.pullLatest')}
              </button>
              {outboxStatus.pending > 0 && (
                <button className="btn-outline" onClick={onRetryNow} disabled={draining}>
                  {draining ? t('settings.retrying') : t('settings.retryNow')}
                </button>
              )}
            </div>
          )}
          <div className="sv2-note">
            {t('settings.syncNote')}
          </div>
        </div>

        {/* ── Reminders ──
             Onboarding's "Maybe later" now genuinely declines, which makes
             this row necessary: without it, declining once was irreversible
             short of a reinstall. */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.remindersLbl')}</div>
          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.reminders')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button
                  className={!state.notifEnabled ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_NOTIF_ENABLED', on: false })}
                >
                  {t('settings.aiOff')}
                </button>
                <button
                  className={state.notifEnabled ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_NOTIF_ENABLED', on: true })}
                >
                  {t('settings.aiOn')}
                </button>
              </span>
            </span>
          </div>
          <div className="sv2-note">
            {state.notifEnabled ? t('settings.remindersOnNote') : t('settings.remindersOffNote')}
          </div>
        </div>

        {/* ── Grades ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.gradesLbl')}</div>
          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.gradeScale')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button className={mode === 'ib' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'ib' })}>IB</button>
                <button className={mode === 'us' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'us' })}>US</button>
              </span>
            </span>
          </div>
          <div className="sv2-note">
            {t('settings.gradeNote')}
          </div>
        </div>

        {/* ── Period history (Archive) ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('history.title')}</div>
          <PeriodHistory courses={state.courses} grades={grades} mode={mode} />
          <div className="sv2-note">{t('history.note')}</div>
        </div>

        {/* ── Your data — GDPR Art. 17 / 20 ─────────────────────────────
             Deliberately buttons rather than a "write to us" address: a right
             the user has to request is a right most of them never exercise. */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.yourData')}</div>
          <div className="sv2-note">{t('settings.yourDataNote')}</div>
          {/* AI debrief opt-in. Off by default — flipping it on is the consent,
              and the note you type is exactly what gets sent. */}
          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.aiDebrief')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button
                  className={!state.aiEnabled ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_AI_ENABLED', on: false })}
                >
                  {t('settings.aiOff')}
                </button>
                <button
                  className={state.aiEnabled ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_AI_ENABLED', on: true })}
                >
                  {t('settings.aiOn')}
                </button>
              </span>
            </span>
          </div>
          <div className="sv2-note">
            {state.aiEnabled ? t('settings.aiDebriefOnNote') : t('settings.aiDebriefOffNote')}
          </div>
          {/* Free-tier disclosure — informed consent belongs at the switch,
              not only in PRIVACY.md. */}
          <div className="sv2-note">{t('settings.aiTrainingNote')}</div>
          <div className="sv2-action">
            <button className="btn-outline" onClick={onExport}>
              {t('settings.exportData')}
            </button>
            <a
              className="btn-outline"
              href="https://limekana.github.io/nexus-command-center/legal/privacy.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('settings.privacyPolicy')}
            </a>
          </div>
          <div className="sv2-danger">
            <div className="sv2-danger-title">{t('settings.dangerZone')}</div>
            <div className="sv2-note">{t('settings.deleteAccountNote')}</div>
            <button
              className="btn-outline sv2-danger-btn"
              onClick={onDeleteAccount}
              disabled={deleting}
            >
              {deleting ? t('settings.deletingAccount') : t('settings.deleteAccount')}
            </button>
          </div>
        </div>

        {/* ── About ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.about')}</div>
          <div className="sv2-row">
            <span className="sv2-row-label">StudyDesk</span>
            <span className="sv2-row-value">v{appVersion}</span>
          </div>
          <details className="sv2-tech">
            <summary>{t('settings.techDetails')}</summary>
            <div className="sv2-tech-grid">
              <div className="sv2-tech-item"><span>{t('settings.bundle')}</span><span>com.StudyDesk.app</span></div>
              <div className="sv2-tech-item"><span>{t('settings.backend')}</span><span>Supabase (hkktorzh…)</span></div>
              {userId && <div className="sv2-tech-item"><span>{t('settings.userId')}</span><span title={userId}>{userIdShort}</span></div>}
              <div className="sv2-tech-item"><span>{t('settings.source')}</span><span><a className="sv2-link" href="https://github.com/Limekana/StudyDesk" target="_blank" rel="noopener noreferrer">github.com/Limekana/StudyDesk</a></span></div>
              <div className="sv2-tech-item"><span>{t('settings.license')}</span><span>MIT</span></div>
            </div>
          </details>
        </div>
      </div>
    </>
  );
}
