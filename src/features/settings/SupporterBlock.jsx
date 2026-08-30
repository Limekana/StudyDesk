// v1.12 Items 6b + 6c — the supporter badge and the Ko-fi alt-email field.
//
// These are two halves of one situation, which is why they live in one block:
// either the entitlement resolved and the user should see it, or it did not and
// the user needs the one self-serve tool that can fix it.
//
// **6c — the badge.** Trivial now the reader ships, and it is the whole visible
// payoff of the monetization chain. Before this, the founding supporter was
// correctly credited in the database and saw nothing in any app.
//
// **6b — the alt-email field.** The webhook logs `no account matches <redacted>
// — needs manual linking` when a supporter checks out with a different address
// than they signed up with. **The server side already works**: `kofi_match_user`
// falls back to `auth.users.raw_user_meta_data->>'kofi_alt_email'`. Only the
// client field was missing, so the only route out was a manual database edit.
//
// It lives in **user metadata, not a `profiles` column** — that is where the
// matcher looks, and putting it anywhere else would be a field that silently
// does nothing.
//
// Honest scope, carried over from the reader's own header: this is a cosmetic
// perk in an open-source, client-only app. Nothing here is an enforcement
// boundary and it is not trying to be one.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../lib/supabase.js';
import { isEntitled, entitlementTier, refreshEntitlement } from '../../lib/entitlement.js';

export default function SupporterBlock({ session, showFlash }) {
  const { t } = useTranslation();
  const [entitled, setEntitled] = useState(() => isEntitled());
  const [tier, setTier] = useState(() => entitlementTier());
  const [altEmail, setAltEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const uid = session?.user?.id;

  const sync = useCallback(async ({ force = false } = {}) => {
    if (!uid) { setEntitled(false); setTier(null); return; }
    await refreshEntitlement(uid, { force });
    setEntitled(isEntitled());
    setTier(entitlementTier());
  }, [uid]);

  useEffect(() => {
    setAltEmail(session?.user?.user_metadata?.kofi_alt_email || '');
    void sync();
  }, [session, sync]);

  if (!session) return null;

  async function saveAltEmail() {
    const value = altEmail.trim().toLowerCase();
    // A malformed address cannot match anything and would leave the user
    // waiting on a link that can never happen, so refuse it here rather than
    // storing it and staying silent.
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      showFlash(t('settings.kofiEmailInvalid'));
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ data: { kofi_alt_email: value || null } });
      if (error) throw error;
      // Force past the six-hour cache: the user has just told us something that
      // could change the answer, and serving them a stale "not entitled" now
      // would look exactly like the field not working.
      await sync({ force: true });
      showFlash(isEntitled() ? t('settings.kofiEmailMatched') : t('settings.kofiEmailSaved'));
    } catch (e) {
      showFlash(t('settings.kofiEmailFailed', { msg: e?.message || 'error' }));
    } finally {
      setBusy(false);
    }
  }

  if (entitled) {
    return (
      <>
        <div className="sv2-supporter">
          <span className="sv2-supporter-mark" aria-hidden="true">✦</span>
          <div>
            <div className="sv2-supporter-title">{t('settings.supporterBadge')}</div>
            <div className="sv2-supporter-sub">
              {tier ? t('settings.supporterTier', { tier }) : t('settings.supporterThanks')}
            </div>
          </div>
        </div>
        <div className="sv2-note">{t('settings.supporterNote')}</div>
      </>
    );
  }

  // Not entitled. Most users are not supporters and should not be nagged, so
  // this is a disclosure the user opens rather than a field sitting in their
  // face — it only matters to someone who has actually paid and is not seeing
  // it, and that person will go looking.
  return (
    <>
      <button type="button" className="sv2-linkish" onClick={() => setOpen((v) => !v)}>
        {t('settings.kofiAlreadySupported')}
      </button>
      {open && (
        <div className="sv2-kofi-link">
          <div className="sv2-note" style={{ marginTop: 0 }}>{t('settings.kofiEmailWhy')}</div>
          <label className="sv2-field-label" htmlFor="sv2-kofi-email">
            {t('settings.kofiEmailLabel')}
          </label>
          <input
            id="sv2-kofi-email"
            className="sv2-time sv2-name-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={altEmail}
            onChange={(e) => setAltEmail(e.target.value)}
            placeholder={t('settings.kofiEmailPh')}
          />
          <div className="sv2-action">
            <button className="sv2-inline-btn" disabled={busy} onClick={() => void saveAltEmail()}>
              {t('settings.kofiEmailSave')}
            </button>
            <button className="sv2-inline-btn" disabled={busy} onClick={() => void sync({ force: true })}>
              {t('settings.kofiRecheck')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
