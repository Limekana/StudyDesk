import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { webNotifyPermission, requestWebNotifyPermission, webNotifySupported } from '../../lib/webNotify.js';
import { Capacitor } from '@capacitor/core';
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
import { focusCapabilities } from '../../lib/focusMode.js';
import { scaleFor, normalizeScale, describeScale } from '../../lib/gradeScale.js';
import { GuestAvatar } from '../../lib/avatar.jsx';
import pkg from '../../../package.json';

// A v4 uuid for a feedback row. crypto.randomUUID needs a secure context, and
// the fallback builds one by hand rather than inventing a non-uuid id string —
// the column is `uuid`, so a "fb-1a2b3c" style fallback would be rejected by
// the database at the worst possible moment (offline, on retry).
function newFeedbackId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const css = `
.sv2-wrap{padding:16px 24px 80px;max-width:680px;margin:0 auto;}
.sv2-section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:14px;}
.sv2-section-title{font-family:var(--font-mono);font-size:10px;letter-spacing:0.18em;color:var(--muted2);text-transform:uppercase;margin-bottom:14px;}

/* Feedback (v1.10) */
.sv2-fb-cats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}
.sv2-fb-cat{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;padding:8px 13px;border-radius:999px;border:1px solid var(--border2);background:var(--bg);color:var(--muted2);cursor:pointer;transition:border-color .15s,background .15s,color .15s;}
.sv2-fb-cat:hover{border-color:var(--muted2);}
.sv2-fb-cat--on{border-color:var(--accent,#2e7d52);background:color-mix(in srgb,var(--accent,#2e7d52) 8%,transparent);color:var(--accent,#2e7d52);font-weight:600;}
.sv2-fb-stars{display:flex;gap:4px;margin-bottom:12px;}
.sv2-fb-star{font-size:21px;line-height:1;background:none;border:none;padding:2px 3px;cursor:pointer;color:var(--border2);transition:color .12s;}
.sv2-fb-star--on{color:var(--accent,#2e7d52);}
.sv2-fb-text{width:100%;min-height:98px;resize:vertical;}
.sv2-fb-count{font-family:var(--font-mono);font-size:10px;color:var(--muted2);text-align:end;margin-top:5px;}

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

/* wrap, because a row is label + control and some controls are wider than the
   space left over. Before this the row simply overflowed its card: 350px of
   content in a 252px box. Wrapping drops the control onto its own line instead,
   which is the only honest option at 375px. */
.sv2-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;font-size:14px;flex-wrap:wrap;}
.sv2-row + .sv2-row{border-top:1px solid var(--border);}
.sv2-row-label{color:var(--muted);font-size:13px;}
.sv2-row-value{font-size:13px;color:var(--text);text-align:end;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
/* flex:0 0 auto because this row is a flex container and the segmented
   control must never be the thing that gives way. Without it, adding the
   Study-until time input next to one starved it down to the width of
   "Off" plus a sliver of the black active button. */
.sv2-mode{display:inline-flex;flex:0 0 auto;border:1px solid var(--border2);border-radius:6px;overflow:hidden;}
/* Four options do not fit at 375px with the default padding. Tighter rather
   than fewer: dropping an option would be choosing for the user which lead
   times matter. */
.sv2-mode.compact button{padding:6px 9px;letter-spacing:0.03em;}
.sv2-mode button{background:transparent;border:none;padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;color:var(--muted);}
.sv2-mode button.active{background:var(--text);color:var(--bg);}

/* Custom grade scale editor (SD-F4) — only rendered when Custom is active. */
.sv2-scale{margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;flex-wrap:wrap;gap:10px;}
.sv2-scale-field{display:flex;flex-direction:column;gap:4px;flex:1 1 84px;}
.sv2-scale-field span{font-family:var(--font-mono);font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted2);}
.sv2-scale-field input{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:7px;padding:8px 10px;font-size:14px;color:var(--text);}
.sv2-scale-dir{flex:1 1 100%;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
.sv2-scale .sv2-note{flex:1 1 100%;margin:0;}
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
/* width:auto overrides the width:100% this input now inherits from the
   shared control selector in forms.css. That inheritance is correct for a
   field stacked in an .input-group and wrong for one sitting in a flex row
   beside a toggle, where 100% means "take everything and squash the rest". */
.sv2-time{width:auto;flex:0 0 auto;min-width:0;background:var(--bg);border:1px solid var(--border2);border-radius:7px;padding:6px 9px;font-family:var(--font-mono);font-size:13px;color:var(--text);}

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

/** minutes past midnight -> the "HH:MM" an <input type="time"> expects. */
function minutesToTimeInput(mins) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Number(mins) || 0));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "HH:MM" -> minutes, or null. A time input can legitimately be empty while
 *  the user is mid-edit, and writing 0 for that would silently move the
 *  ceiling to midnight instead of leaving it alone. */
function timeInputToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export default function SettingsView({ state, dispatch, showFlash, session }) {
  // v1.10 (Item 12) — ask the device what it can do before offering anything.
  // A settings switch that silently does nothing is worse than an absent one,
  // because the user cannot tell it apart from a bug. Null until the answer
  // arrives, which is also the correct state on web (the probe resolves to all
  // -false there and the section never renders).
  // ── Feedback (v1.10) ──────────────────────────────────────────────────
  const FEEDBACK_MAX = 4000;
  const FEEDBACK_CATEGORIES = ['bug', 'idea', 'praise', 'other'];
  const [fbCategory, setFbCategory] = useState('bug');
  const [fbRating, setFbRating] = useState(0);
  const [fbMessage, setFbMessage] = useState('');

  const [focusCaps, setFocusCaps] = useState(null);
  // Remembers the time across an off/on round trip. Without it, switching the
  // setting off and back on silently resets 22:30 to the 21:00 default, which
  // reads as the app forgetting rather than as a default.
  // Browser-notification permission, web only. Tracked in state because the
  // answer changes in response to a prompt this component raises.
  // Native detection is a constant for the lifetime of the process, so it is a
  // plain const rather than state.
  const isNative = Capacitor.isNativePlatform();
  const [webPerm, setWebPerm] = useState(() => webNotifyPermission());
  const lastStudyUntil = useRef(state.studyUntil ?? 21 * 60);
  if (state.studyUntil !== null) lastStudyUntil.current = state.studyUntil;
  useEffect(() => { let live = true; focusCapabilities().then((c) => { if (live) setFocusCaps(c); }); return () => { live = false; }; }, []);
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
  // The draft holds raw strings so a half-typed value survives a keystroke:
  // normalising on every change would snap an emptied field back to its default
  // and make the input impossible to edit. The reducer always receives the
  // normalised value, so the rest of the app never sees a partial scale.
  const [scaleDraft, setScaleDraft] = useState(() => ({ ...scaleFor('custom', state.customScale) }));
  const activeScale = normalizeScale(scaleDraft);
  const setScale = useCallback((patch) => {
    setScaleDraft((prev) => {
      const next = { ...prev, ...patch };
      dispatch({ type: 'SET_CUSTOM_SCALE', scale: next });
      return next;
    });
  }, [dispatch]);

  // Goes through the outbox rather than straight to Supabase, so a report
  // written on a train is not lost — enqueue persists first and drains on the
  // next connection. enqueue() does not throw and does not need awaiting, so
  // there is no failure path to show here; a delivery problem surfaces in the
  // Cloud sync panel like every other queued write.
  const handleSendFeedback = useCallback(() => {
    const message = fbMessage.trim();
    if (!message) { showFlash(t('settings.feedbackEmpty')); return; }
    if (!session) { showFlash(t('settings.feedbackSignIn')); return; }
    outbox.enqueue('submit_feedback', {
      id: newFeedbackId(),
      category: fbCategory,
      rating: fbRating || null,
      message,
      appVersion: pkg.version,
      platform: Capacitor.getPlatform(),
    });
    setFbMessage('');
    setFbRating(0);
    showFlash(t('settings.feedbackThanks'));
  }, [fbMessage, fbCategory, fbRating, session, showFlash, t]);

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
      await supabase.auth.signOut({ scope: 'local' });
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

        {/* ── Planning (v1.10, owner feedback) ──────────────────────────
            The calendar's free-window list used to end at the last thing
            already in the day, so an afternoon that finished at 15:00 reported
            no free time after 15:00 — which is exactly the time a student
            plans into. This says how late you are actually willing to work. */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.planningLbl')}</div>

          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.studyUntil')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button
                  className={state.studyUntil === null ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_STUDY_UNTIL', minutes: null })}
                >
                  {t('settings.aiOff')}
                </button>
                <button
                  className={state.studyUntil !== null ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_STUDY_UNTIL', minutes: lastStudyUntil.current })}
                >
                  {t('settings.aiOn')}
                </button>
              </span>
              {state.studyUntil !== null && (
                <input
                  type="time"
                  className="sv2-time"
                  aria-label={t('settings.studyUntil')}
                  value={minutesToTimeInput(state.studyUntil)}
                  onChange={(e) => {
                    const v = timeInputToMinutes(e.target.value);
                    if (v !== null) dispatch({ type: 'SET_STUDY_UNTIL', minutes: v });
                  }}
                />
              )}
            </span>
          </div>
          <div className="sv2-note">
            {state.studyUntil === null
              ? t('settings.studyUntilOffNote')
              : t('settings.studyUntilOnNote', { time: minutesToTimeInput(state.studyUntil) })}
          </div>

          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.planRemindLead')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode compact">
                {[null, 10, 30, 60].map((m) => (
                  <button
                    key={m === null ? 'off' : m}
                    className={state.planRemindLead === m ? 'active' : ''}
                    onClick={() => dispatch({ type: 'SET_PLAN_REMIND', lead: m })}
                  >
                    {m === null ? t('settings.aiOff') : t('settings.minsShort', { n: m })}
                  </button>
                ))}
              </span>
            </span>
          </div>

          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.planRemindStart')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button
                  className={!state.planRemindStart ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_PLAN_REMIND', atStart: false })}
                >
                  {t('settings.aiOff')}
                </button>
                <button
                  className={state.planRemindStart ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_PLAN_REMIND', atStart: true })}
                >
                  {t('settings.aiOn')}
                </button>
              </span>
            </span>
          </div>
          <div className="sv2-note">
            {state.notifEnabled
              ? t('settings.planRemindNote')
              : t('settings.planRemindBlocked')}
          </div>

          {/* Web only. On Android these are OS alarms and there is nothing to
              grant here beyond the notification permission the app already
              asks for; showing a second, differently-worded control there
              would imply two separate things to switch on. */}
          {!isNative && webNotifySupported() && (
            <>
              <div className="sv2-row">
                <span className="sv2-row-label">{t('settings.webNotify')}</span>
                <span className="sv2-row-value">
                  {webPerm === 'granted' ? (
                    <span className="sv2-row-value">{t('settings.webNotifyOn')}</span>
                  ) : webPerm === 'denied' ? (
                    <span className="sv2-row-value" style={{ color: 'var(--danger)' }}>
                      {t('settings.webNotifyBlocked')}
                    </span>
                  ) : (
                    <button
                      className="btn-outline"
                      onClick={async () => setWebPerm(await requestWebNotifyPermission())}
                    >
                      {t('settings.webNotifyAsk')}
                    </button>
                  )}
                </span>
              </div>
              <div className="sv2-note">
                {webPerm === 'denied'
                  ? t('settings.webNotifyDeniedNote')
                  : t('settings.webNotifyNote')}
              </div>
            </>
          )}
        </div>

        {/* ── Lock In (v1.10, Item 12) — native only ── */}
        {focusCaps?.notifications && (
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.lockInLbl')}</div>

          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.focusChip')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button
                  className={!state.focusChip ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_FOCUS_CHIP', on: false })}
                >
                  {t('settings.aiOff')}
                </button>
                <button
                  className={state.focusChip ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_FOCUS_CHIP', on: true })}
                >
                  {t('settings.aiOn')}
                </button>
              </span>
            </span>
          </div>
          <div className="sv2-note">
            {state.focusChip
              ? (focusCaps.promotedOngoing ? t('settings.focusChipOnNote') : t('settings.focusChipOnNoteLegacy'))
              : t('settings.focusChipOffNote')}
          </div>

          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.focusPin')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button
                  className={!state.focusPin ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_FOCUS_PIN', on: false })}
                >
                  {t('settings.aiOff')}
                </button>
                <button
                  className={state.focusPin ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_FOCUS_PIN', on: true })}
                >
                  {t('settings.aiOn')}
                </button>
              </span>
            </span>
          </div>
          <div className="sv2-note">
            {state.focusPin ? t('settings.focusPinOnNote') : t('settings.focusPinOffNote')}
          </div>
        </div>
        )}

        {/* ── Grades ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.gradesLbl')}</div>
          <div className="sv2-row">
            <span className="sv2-row-label">{t('settings.gradeScale')}</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button className={mode === 'ib' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'ib' })}>IB</button>
                <button className={mode === 'us' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'us' })}>US</button>
                <button className={mode === 'custom' ? 'active' : ''} onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'custom' })}>{t('gv.modeCustom')}</button>
              </span>
            </span>
          </div>
          {/* SD-F4 — the editor only appears once Custom is the active mode, so
              the section stays a single row for the IB and US majority. */}
          {mode === 'custom' && (
            <div className="sv2-scale">
              <label className="sv2-scale-field">
                <span>{t('settings.scaleMin')}</span>
                <input
                  type="number" step="0.5" value={scaleDraft.min}
                  onChange={(e) => setScale({ min: e.target.value })}
                />
              </label>
              <label className="sv2-scale-field">
                <span>{t('settings.scaleMax')}</span>
                <input
                  type="number" step="0.5" value={scaleDraft.max}
                  onChange={(e) => setScale({ max: e.target.value })}
                />
              </label>
              <label className="sv2-scale-field">
                <span>{t('settings.scalePass')}</span>
                <input
                  type="number" step="0.5" value={scaleDraft.passMark}
                  onChange={(e) => setScale({ passMark: e.target.value })}
                />
              </label>
                <label className="sv2-scale-field" style={{ flex: '1 1 100%' }}>
            <span>{t('settings.scaleName')}</span>
            <input
              type="text"
              value={scaleDraft.name || ''}
              placeholder={t('gv.customAverage')}
              onChange={(e) => setScale({ name: e.target.value })}
            />
          </label>
        <div className="sv2-scale-dir">
                <span className="sv2-row-label">{t('settings.scaleDirection')}</span>
                <span className="sv2-mode">
                  <button
                    className={scaleDraft.direction === 'up' ? 'active' : ''}
                    onClick={() => setScale({ direction: 'up' })}
                  >
                    {t('settings.scaleHighBest')}
                  </button>
                  <button
                    className={scaleDraft.direction === 'down' ? 'active' : ''}
                    onClick={() => setScale({ direction: 'down' })}
                  >
                    {t('settings.scaleLowBest')}
                  </button>
                </span>
              </div>
              <div className="sv2-note">{describeScale(activeScale, t)}</div>
            </div>
          )}
          <div className="sv2-note">
            {mode === 'custom' ? t('settings.gradeNoteCustom') : t('settings.gradeNote')}
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

        {/* ── Feedback (v1.10) ──
            Deliberately in the app rather than a survey link: a link leaves
            the app, cannot work offline, and arrives without the app version
            or platform, which is most of what makes a report actionable. */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.feedback')}</div>
          <div className="sv2-note">{t('settings.feedbackBlurb')}</div>

          <div className="sv2-fb-cats" role="group" aria-label={t('settings.feedbackCategory')}>
            {FEEDBACK_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`sv2-fb-cat${fbCategory === c ? ' sv2-fb-cat--on' : ''}`}
                onClick={() => setFbCategory(c)}
                aria-pressed={fbCategory === c}
              >
                {t(`settings.fbCat.${c}`)}
              </button>
            ))}
          </div>

          <div className="sv2-fb-stars" role="group" aria-label={t('settings.feedbackRating')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`sv2-fb-star${n <= fbRating ? ' sv2-fb-star--on' : ''}`}
                onClick={() => setFbRating(n === fbRating ? 0 : n)}
                aria-label={t('settings.feedbackRatingN', { n })}
                aria-pressed={n <= fbRating}
              >
                {n <= fbRating ? '★' : '☆'}
              </button>
            ))}
          </div>

          <textarea
            className="sv2-fb-text"
            value={fbMessage}
            maxLength={FEEDBACK_MAX}
            onChange={(e) => setFbMessage(e.target.value)}
            placeholder={t('settings.feedbackPlaceholder')}
            aria-label={t('settings.feedback')}
          />
          <div className="sv2-fb-count">{fbMessage.length}/{FEEDBACK_MAX}</div>

          <div className="sv2-action">
            <button
              className="btn-outline"
              onClick={handleSendFeedback}
              disabled={!fbMessage.trim()}
            >
              {t('settings.feedbackSend')}
            </button>
          </div>
          <div className="sv2-note">{t('settings.feedbackMeta', { app: 'StudyDesk', version: appVersion })}</div>
        </div>

        {/* ── Support ──
            A link out, nothing more. No entitlements, no supporter-only
            features, no webhook — nothing here gates the app or changes
            behaviour for someone who never clicks it. */}
        <div className="sv2-section">
          <div className="sv2-section-title">{t('settings.support')}</div>
          <div className="sv2-note">{t('settings.supportDevSub')}</div>
          <div className="sv2-action">
            <a
              className="btn-outline"
              href="https://ko-fi.com/limecorestudio"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('settings.supportDev')}
            </a>
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
