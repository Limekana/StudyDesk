// v1.17 (limecore#10) — change the account's login email, from Settings.
//
// Source: feedback 2026-09-18, 5 stars, StudyDesk 1.14.0: wants to change the
// login email and have it apply in NCC and the other apps too. All three apps
// share one Supabase auth user, so a single `updateUser({ email })` changes it
// everywhere; nothing app-specific moves.
//
// How it completes: with "Secure email change" on (Supabase's default, and the
// project must keep it on), Supabase mails a confirmation link to the current
// address AND the new one, and the address changes once both are opened. The
// links land on limecore.dev/confirmed, not in the app. Until then the user
// keeps signing in with the old address, which the copy says plainly.
//
// Only for accounts that sign in with email and password. For a Google
// account the address comes from Google; changing it here is untested and
// would not change how they sign in, so the control is not offered.
//
// Release gate: NCC's 20261005_kofi_match_follows_email_change.sql must be
// live before this ships, or a supporter who changes their email loses their
// Ko-fi renewals (and someone else could claim them).

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../lib/supabase.js';
import { enterSubmit } from '../../lib/imeSubmit.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ChangeEmail({ session, showFlash }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // A change that is waiting on its confirmation links: from the server, so it
  // survives a restart and shows on every device.
  const [pending, setPending] = useState(null);

  const user = session?.user;
  const providers = user?.app_metadata?.providers || [user?.app_metadata?.provider];
  const usesPassword = !!user && !user.is_anonymous && providers.includes('email');
  const current = user?.email || '';

  // getUser() reads the user from the server without rotating any token, so
  // it is safe to call on every visit to Settings (see the 2026-08-07 SSO
  // token-burn lesson: never refresh a session in a loop).
  const userId = user?.id;
  useEffect(() => {
    if (!userId || !usesPassword) return undefined;
    let live = true;
    supabase.auth.getUser()
      .then(({ data }) => { if (live) setPending(data?.user?.new_email || null); })
      .catch(() => {});
    return () => { live = false; };
  }, [userId, usesPassword]);

  if (!usesPassword) return null;

  async function send() {
    const next = value.trim().toLowerCase();
    if (!EMAIL_RE.test(next)) { showFlash(t('settings.kofiEmailInvalid')); return; }
    if (next === current.toLowerCase()) { showFlash(t('settings.changeEmailSame')); return; }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ email: next });
      if (error) throw error;
      setPending(next);
      setValue('');
      setOpen(false);
    } catch (e) {
      const code = e?.code || '';
      showFlash(
        code === 'email_exists' ? t('settings.changeEmailTaken')
          : code === 'email_address_invalid' ? t('settings.kofiEmailInvalid')
            : /rate_limit/.test(code) || e?.status === 429 ? t('settings.changeEmailRateLimit')
              : t('settings.changeEmailFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {pending && (
        <div className="sv2-note">{t('settings.changeEmailPending', { current, next: pending })}</div>
      )}
      <button type="button" className="sv2-linkish" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {t('settings.changeEmail')}
      </button>
      {open && (
        <div className="sv2-kofi-link">
          <div className="sv2-note" style={{ marginTop: 0 }}>{t('settings.changeEmailWhy')}</div>
          <label className="sv2-field-label" htmlFor="sv2-new-email">{t('settings.changeEmailLabel')}</label>
          <input
            id="sv2-new-email"
            className="sv2-time sv2-name-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            {...enterSubmit(() => { void send(); })}
            placeholder={t('settings.kofiEmailPh')}
          />
          <div className="sv2-action">
            <button className="btn-outline" disabled={busy || !value.trim()} onClick={() => void send()}>
              {t('settings.changeEmailSend')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
