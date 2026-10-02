// v1.16 (limecore#16, NCC#50) — "the privacy policy changed", shown once.
//
// The policy's own "Changes" section promises that a material change is
// announced in the app. v1.16's change is error reports (opt-in) and the
// Android F-Droid update check. The note is for people who were already using
// StudyDesk under the old text; someone installing now meets the new policy at
// sign-up, so a fresh install is marked as having seen it.
//
// Bump POLICY_VERSION only for a material change, and announce it once.
export const POLICY_VERSION = '2026-09-v1.16';
export const POLICY_URL = 'https://limekana.github.io/nexus-command-center/legal/privacy.html';
const KEY = 'sd-policy-seen';

/** Called from main.jsx before onboarding can run: a device that has never
 *  onboarded is a fresh install, so it starts on the current policy. */
export function notePolicyBaseline() {
  try {
    const onboarded = localStorage.getItem('studydesk-onboarded') === '1';
    if (!onboarded && localStorage.getItem(KEY) == null) localStorage.setItem(KEY, POLICY_VERSION);
  } catch { /* no storage: the note simply shows, which errs on the side of telling */ }
}

export function policyNoticeDue() {
  try { return localStorage.getItem(KEY) !== POLICY_VERSION; } catch { return false; }
}

export function acknowledgePolicy() {
  try { localStorage.setItem(KEY, POLICY_VERSION); } catch { /* best effort */ }
}
