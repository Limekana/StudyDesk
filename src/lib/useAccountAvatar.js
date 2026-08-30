// v1.12 Item 9 follow-up — one resolved avatar, shared by every place that
// draws one.
//
// Shipped incomplete: the Settings preview rendered the glyph/colour/photo, but
// the topbar button still called `avatarInitials()` directly, so a user could
// set an avatar and then not see it anywhere except the screen where they set
// it. Caught on-device.
//
// Lives in its own file rather than beside the component, because
// `react-hooks/only-export-components` rejects a module exporting both a
// component and a plain function and this app lints at --max-warnings 0 — the
// same reason `avatarInitials` was split out.

import { useEffect, useState, useCallback } from 'react';
import { loadProfile, resolveAvatar, PROFILE_CHANGE_EVENT } from './profile.js';
import { avatarInitials } from './avatarInitials.js';

/**
 * The avatar to draw right now.
 *
 * Re-resolves on sign-in and whenever the profile is edited anywhere in the
 * app, so changing a glyph in Settings updates the topbar in the same frame
 * rather than on the next cold start.
 */
export function useAccountAvatar(session) {
  const [state, setState] = useState({ kind: 'initials', glyph: null, color: null, url: null });

  // One effect, one subscription, one cancellation flag.
  //
  // `resolve` is async and every setState below happens after an await, so this
  // is the "subscribe to an external system and setState in a callback" case
  // the react-hooks rule explicitly allows — not a synchronous cascade. The
  // `alive` guard is what makes that true in practice: without it a slow signed
  // URL could resolve after the component unmounted, or after a sign-out, and
  // write the previous account's avatar into a fresh render.
  const resolve = useCallback(async (alive) => {
    if (!session) return { kind: 'initials', glyph: null, color: null, url: null };
    const p = await loadProfile();
    const next = await resolveAvatar(p);
    return alive() ? next : null;
  }, [session]);

  useEffect(() => {
    let alive = true;
    const isAlive = () => alive;
    const run = () => { void resolve(isAlive).then((next) => { if (next) setState(next); }); };
    run();
    if (typeof window !== 'undefined') window.addEventListener(PROFILE_CHANGE_EVENT, run);
    return () => {
      alive = false;
      if (typeof window !== 'undefined') window.removeEventListener(PROFILE_CHANGE_EVENT, run);
    };
  }, [resolve]);

  // The tint travels WITH the resolved avatar rather than being re-derived by
  // each caller. Settings applied it and the topbar did not, so the same avatar
  // rendered coloured on one screen and plain on another — the second time a
  // duplicated render rule diverged in this feature.
  //
  // Only for glyph/initials: a photo fills the circle, so tinting behind it
  // would show as a rim of colour around the crop.
  const tintStyle = state.kind !== 'image' && state.color
    ? { background: state.color, color: '#fff', borderColor: state.color }
    : undefined;

  return { ...state, initials: avatarInitials(session), tintStyle };
}
