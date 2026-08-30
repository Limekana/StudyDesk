// v1.12 Item 9 — the editable profile block in Settings.
//
// Source: `feedback` 2026-08-28, rated 4/5, Spanish — wants to edit their
// username and add an avatar. The only rated feedback row in the table.
//
// The preview is the point of the layout: every control below it changes the
// circle above it immediately, so the user is never choosing a glyph or a
// colour in the abstract.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { COURSE_COLORS } from '../../lib/courseColors.js';
import { avatarInitials } from '../../lib/avatarInitials.js';
import {
  AVATAR_GLYPHS, loadProfile, saveProfile, uploadAvatar, removeAvatar, resolveAvatar, hasAvatarObject,
} from '../../lib/profile.js';
import { ACCEPTED_INPUT_TYPES } from '../../lib/imageEncode.js';
import { AccountAvatar } from '../../lib/avatar.jsx';

export default function ProfileSection({ session, showFlash }) {
  const { t } = useTranslation();
  const fileRef = useRef(null);

  const [profile, setProfile] = useState(null);
  const [name, setName] = useState('');
  const [resolved, setResolved] = useState({ kind: 'initials', glyph: null, color: null, url: null });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const p = await loadProfile();
    setProfile(p);
    setName(p?.full_name || '');
    setResolved(await resolveAvatar(p));
  }, []);

  useEffect(() => { if (session) void refresh(); }, [session, refresh]);

  // Guests have no server-side profile to edit. Rendering the controls and
  // failing on save would be worse than not offering them.
  if (!session) return null;

  const patch = async (fields, flashKey) => {
    setBusy(true);
    try {
      await saveProfile(fields);
      await refresh();
      if (flashKey) showFlash(t(flashKey));
    } catch (e) {
      showFlash(t('settings.profileSaveFailed', { msg: e?.message || 'error' }));
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    // Reset immediately so choosing the SAME file again still fires a change.
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      await uploadAvatar(file);
      await refresh();
      showFlash(t('settings.avatarUploaded'));
    } catch (err) {
      // Every failure mode gets its own message — "upload failed" would leave
      // the user with no idea whether to pick a smaller file, a different
      // format, or delete something.
      const key = {
        'bad-type': 'settings.avatarBadType',
        'decode-failed': 'settings.avatarBadImage',
        'too-large': 'settings.avatarTooLarge',
        'quota-exceeded': 'settings.avatarQuota',
        'not-signed-in': 'settings.notSignedIn',
      }[err?.code] || 'settings.avatarFailed';
      showFlash(t(key));
    } finally {
      setBusy(false);
    }
  };

  const kind = resolved.kind;
  // Same rule the topbar uses, derived once here rather than written twice.
  const tintStyle = kind !== 'image' && resolved.color
    ? { background: resolved.color, color: '#fff', borderColor: resolved.color }
    : undefined;

  return (
    <div className="sv2-section">
      <div className="sv2-section-title">{t('settings.profileLbl')}</div>

      <div className="sv2-profile-preview">
        <div
          className="sv2-avatar sv2-avatar-lg"
          style={tintStyle}
        >
          <AccountAvatar
            avatar={{ ...resolved, initials: avatarInitials(session) }}
            session={session}
          />
        </div>
        <div className="sv2-profile-name-field">
          <label className="sv2-field-label" htmlFor="sv2-display-name">
            {t('settings.displayName')}
          </label>
          <input
            id="sv2-display-name"
            className="sv2-time sv2-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if ((profile?.full_name || '') !== name.trim()) void patch({ fullName: name }, 'settings.profileSaved');
            }}
            maxLength={60}
            placeholder={t('settings.displayNamePh')}
          />
        </div>
      </div>

      {/* Which avatar to use. Image is offered even with no file uploaded yet —
          picking it opens the file dialog, which is one tap fewer than making
          the user choose the mode and then find a separate upload button. */}
      <div className="sv2-row">
        <span className="sv2-row-label">{t('settings.avatarStyle')}</span>
        <span className="sv2-row-value">
          <span className="sv2-mode compact">
            <button
              className={kind === 'initials' ? 'active' : ''}
              disabled={busy}
              onClick={() => void patch({ avatarKind: 'initials' })}
            >
              {t('settings.avatarInitials')}
            </button>
            <button
              className={kind === 'glyph' ? 'active' : ''}
              disabled={busy}
              onClick={() => void patch({ avatarKind: 'glyph', avatarGlyph: profile?.avatar_glyph || AVATAR_GLYPHS[0] })}
            >
              {t('settings.avatarGlyph')}
            </button>
            <button
              className={kind === 'image' ? 'active' : ''}
              disabled={busy}
              onClick={async () => {
                // If a photo is already uploaded, switching to Photo should just
                // USE it. Opening the picker unconditionally made an existing
                // avatar look like it had not saved, which is how it read
                // on-device.
                if (await hasAvatarObject()) { await patch({ avatarKind: 'image' }); return; }
                fileRef.current?.click();
              }}
            >
              {t('settings.avatarImage')}
            </button>
          </span>
        </span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_INPUT_TYPES.join(',')}
        onChange={onPickFile}
        style={{ display: 'none' }}
      />

      {kind === 'glyph' && (
        <div className="sv2-glyph-grid">
          {AVATAR_GLYPHS.map((g) => (
            <button
              key={g}
              type="button"
              disabled={busy}
              aria-label={g}
              className={'sv2-glyph' + (resolved.glyph === g ? ' sv2-glyph--on' : '')}
              onClick={() => void patch({ avatarKind: 'glyph', avatarGlyph: g })}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {kind !== 'image' && (
        <div className="sv2-color-grid">
          {COURSE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              disabled={busy}
              aria-label={c}
              className={'sv2-swatch' + (resolved.color === c ? ' sv2-swatch--on' : '')}
              style={{ background: c }}
              onClick={() => void patch({ avatarColor: c })}
            />
          ))}
        </div>
      )}

      {kind === 'image' && (
        <div className="sv2-action">
          <button className="sv2-inline-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {t('settings.avatarReplace')}
          </button>
          <button
            className="sv2-inline-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await removeAvatar('initials'); await refresh(); showFlash(t('settings.avatarRemoved')); }
              finally { setBusy(false); }
            }}
          >
            {t('settings.avatarRemove')}
          </button>
        </div>
      )}

      <div className="sv2-note">{t('settings.avatarNote')}</div>
    </div>
  );
}
