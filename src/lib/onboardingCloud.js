// v1.10 — "onboarding completed" belongs to the ACCOUNT, not the device.
//
// The flag was `localStorage['studydesk-onboarded']` and nothing else, which is
// per-origin and per-device. A returning user on a new phone, a new browser, a
// reinstall — or, until today's Electron origin fix, simply the next launch of
// the desktop build — looked brand new and was made to sit through the wizard
// again. Reported by the owner on an account that had completed it long before.
//
// localStorage stays the fast path and the only path for guests: it answers
// synchronously during the first render, so a signed-out or offline user gets
// the same instant decision as before. The cloud read is the correction layer,
// and it only ever turns the wizard OFF — a false negative from a failed
// network call shows the wizard to someone who has seen it, which is annoying;
// a false positive would hide first-run setup from someone who genuinely needs
// it, which is worse. So every failure path here resolves to "not onboarded"
// and lets the local flag decide.

import { supabase } from './supabase.js';

const KEY = 'studydesk-onboarded';

export function isOnboardedLocal() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setOnboardedLocal() {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* private mode — the cloud flag still carries it */
  }
}

async function currentUserId() {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Record completion against the account. Best-effort: the local flag has
 *  already been set by the caller, so a failure here costs a repeat wizard on
 *  the NEXT device, not a broken finish on this one. */
export async function markOnboardedCloud() {
  const userId = await currentUserId();
  if (!userId) return;
  try {
    const { error } = await supabase.from('user_preferences').upsert(
      {
        user_id: userId,
        studydesk_onboarded: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (error) console.warn('[onboarding] cloud write failed:', error.message);
  } catch (e) {
    console.warn('[onboarding] cloud write threw:', e.message);
  }
}

/** Ask the account whether this user has already onboarded anywhere.
 *  Returns true only on a definite yes. Also back-fills: a user whose device
 *  says done but whose account does not know yet gets pushed up, so the very
 *  first run of this version is the last time they ever see the wizard. */
export async function hydrateOnboardedFromCloud() {
  const userId = await currentUserId();
  if (!userId) return false;
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('studydesk_onboarded')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return false;
    if (data?.studydesk_onboarded) {
      setOnboardedLocal();
      return true;
    }
    if (isOnboardedLocal()) await markOnboardedCloud();
    return false;
  } catch {
    return false;
  }
}
