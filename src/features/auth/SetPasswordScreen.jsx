import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../lib/supabase.js';
import { translateAuthError } from '../../lib/authErrors.js';
import { endRecovery } from '../../lib/passwordRecovery.js';
import { authCss } from './AuthGate.jsx';

// ── Set a new password (#52) ───────────────────────────────────────────────
//
// Reached with a session already in hand — proving the mailbox is what creates
// it — so this screen's job is to stop that session from becoming an ordinary
// signed-in one until the password is actually changed. App.jsx renders it in
// place of the whole app while `isRecoveryPending()`; see lib/passwordRecovery.js
// for why the flag cannot live in a component.
//
// Two rules it follows from the rest of this app:
//
//   * Every rejection SAYS something. The 1.12.1 H1 defect was two bare
//     `return`s in a sheet's submit handler; the OTP field's comment spells out
//     the rule that replaced them — let the press land and name the problem.
//     So: no disabled submit button, and a mismatch or a short password is a
//     sentence on screen, not a no-op.
//   * There is always a way out. A flag that can block the app must have an
//     escape hatch, or a recovery someone abandons halfway becomes a launch
//     that never opens. Signing out ends the flow (the module clears the flag
//     on SIGNED_OUT) and returns the gate.
const MIN_LENGTH = 6;

export default function SetPasswordScreen() {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr('');
    if (password.length < MIN_LENGTH) { setErr(t('auth.errPwShort', { n: MIN_LENGTH })); return; }
    if (password !== confirm) { setErr(t('auth.errPwMismatch')); return; }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      // Only now is the session an ordinary one. Clearing the flag is what
      // hands the app back — App.jsx is subscribed to this module.
      endRecovery();
    } catch (e2) {
      setErr(translateAuthError(e2, t, 'auth.errSetPassword'));
    } finally {
      setLoading(false);
    }
  }

  async function onSignOut() {
    setLoading(true);
    try {
      await supabase.auth.signOut();
    } catch {
      /* the flag below is the real exit; a failed network sign-out must not
         be able to strand someone on this screen */
    } finally {
      // Deliberately NOT setGuestMode(true), which is what the Settings
      // sign-out does. That flag exists to stop the next cold start silently
      // re-inheriting a session from NCC and undoing a sign-out the user
      // asked for — but this button is someone abandoning a password reset,
      // and what they want is the sign-in screen back, not to be dropped into
      // guest mode with sync off. Setting it here sent them into the app as a
      // guest instead, which is how the verification run caught it.
      endRecovery();
      setLoading(false);
    }
  }

  return (
    <>
      <style>{authCss}</style>
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-wordmark">StudyDesk</div>
          <div className="auth-tagline">{t('auth.tagline')}</div>
          <div className="auth-title">{t('auth.setPwTitle')}</div>
          <div className="auth-sub">{t('auth.setPwSub')}</div>

          {err && <div className="auth-error">{err}</div>}

          <form onSubmit={onSubmit}>
            <div className="input-group">
              <label className="input-label">{t('auth.newPasswordLabel')}</label>
              <input
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => { setPassword(e.target.value); setErr(''); }}
              />
            </div>
            <div className="input-group">
              <label className="input-label">{t('auth.confirmPasswordLabel')}</label>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setErr(''); }}
              />
            </div>
            {/* Not disabled on an incomplete form — see the header comment. */}
            <button type="submit" className="btn auth-submit" disabled={loading}>
              {loading ? '…' : t('auth.setPwSubmit')}
            </button>
          </form>

          <div className="auth-otp-actions">
            <button type="button" onClick={onSignOut} disabled={loading}>
              {t('auth.setPwSignOut')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
