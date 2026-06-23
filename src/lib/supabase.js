import { createClient } from '@supabase/supabase-js';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

// Supabase backend — overridable at build time via Vite env vars so the app
// can be re-built against a self-hosted Supabase instance without forking
// (see `.env.example`). The defaults below point at the canonical StudyDesk
// project shared with Nexus Command Center, so the public build keeps working.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ||
  'https://hkktorzhaqnfqsnlstda.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'sb_publishable_ykHLJ4QuFm2HKXACygwezw_c_cvR_yf';

// Capacitor Preferences uses Android SharedPreferences — more durable than
// WebView localStorage, which Android can evict under memory pressure.
const capacitorStorage = {
  async getItem(key) {
    try {
      const { value } = await Preferences.get({ key });
      return value;
    } catch {
      return localStorage.getItem(key);
    }
  },
  async setItem(key, value) {
    try {
      await Preferences.set({ key, value });
    } catch {
      localStorage.setItem(key, value);
    }
  },
  async removeItem(key) {
    try {
      await Preferences.remove({ key });
    } catch {
      localStorage.removeItem(key);
    }
  },
};

const isNative = Capacitor.isNativePlatform();

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: isNative ? capacitorStorage : undefined,
    storageKey: 'studydesk-supabase-session',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

// NOTE: URI scheme must be lowercase. Supabase normalizes redirect URLs
// per RFC 3986 (which says the scheme part of a URI is case-insensitive
// and SHOULD be lowercased), so even if we send mixed-case here Supabase
// rewrites it to lowercase. Android scheme matching IS case-sensitive,
// so the AndroidManifest intent filter and this constant must match the
// lowercased form. The Android package/bundle id (com.StudyDesk.app) is
// unrelated and stays as-is.
export const OAUTH_REDIRECT_URL = 'com.studydesk.app://login-callback';
