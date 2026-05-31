// v1.4 — cross-app SSO consumer (StudyDesk side).
//
// Mirror of LimeLog's suiteSso.ts. Queries NCC's signature-protected
// SessionContentProvider and applies the returned bundle to StudyDesk's
// Supabase client. See LimeLog's wrapper for the full design rationale.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from './supabase.js';

const SuiteSso = registerPlugin('SuiteSso');

/** Pull NCC's active session and apply it to StudyDesk's Supabase client.
 *  No-op on web. Returns { ok, reason?, email? }. */
export async function inheritFromNexus() {
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, reason: 'Cross-app sign-in is only available on Android.' };
  }
  let queryResult;
  try {
    queryResult = await SuiteSso.getNexusSession();
  } catch (e) {
    return { ok: false, reason: 'SSO plugin unavailable: ' + e.message };
  }
  if (!queryResult.available) {
    return { ok: false, reason: queryResult.reason || 'No Nexus session available.' };
  }
  let bundle;
  try {
    bundle = JSON.parse(queryResult.bundleJson || '{}');
  } catch {
    return { ok: false, reason: 'Nexus returned a malformed session bundle.' };
  }
  if (!bundle.access_token || !bundle.refresh_token) {
    return { ok: false, reason: 'Nexus session missing required tokens.' };
  }
  const { error } = await supabase.auth.setSession({
    access_token: bundle.access_token,
    refresh_token: bundle.refresh_token,
  });
  if (error) {
    return { ok: false, reason: 'Supabase rejected the inherited session: ' + error.message };
  }
  return { ok: true, email: bundle.email };
}
