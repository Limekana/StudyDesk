// v1.12 Item 9 — the editable profile: display name, glyph, colour, image.
//
// Source: `feedback` 2026-08-28, rated 4/5 — the only rated row in the table,
// from a user who likes the app and wants to edit their name and add an avatar.
//
// **Render order is image -> glyph -> initials, and every step degrades.** A
// failed signed URL, an offline start, a cleared cache or a null column all
// fall through to something correct rather than to a broken image. That is why
// `avatar_kind` is advisory here rather than authoritative: it says what the
// user CHOSE, and the resolver still checks whether that choice can be honoured
// right now.
//
// **Egress is the tighter constraint, not storage** (the plan's `O-5`/`C-6`
// note). 540 users x 256 KB is ~138 MB of storage, which is fine; re-fetching
// an avatar on every render is what would actually hurt. So the signed URL is
// cached locally and only refreshed when it expires or when the profile row
// says the image changed.

import { supabase } from './supabase.js';
import { encodeAvatar } from './imageEncode.js';
import { uploadForUser, removeForUser, signedUrlForUser } from './userStorage.js';

export const AVATAR_BUCKET = 'avatars';
/** ONE object per user, forever. A user cannot accumulate files, storage is
 *  bounded by construction and no cleanup job is ever needed. The single most
 *  important decision in this item. */
export const AVATAR_FILE = 'avatar.webp';

const CACHE_KEY = 'studydesk.avatarCache';
/** Signed URLs last an hour server-side; refresh a little early so a render
 *  never lands on one that expired mid-request. */
const URL_TTL_MS = 55 * 60 * 1000;

/** The glyph set. Deliberately small and neutral — a picker, not a keyboard. */
export const AVATAR_GLYPHS = [
  '✦', '✿', '❋', '◆', '●', '▲',
  '♪', '☾', '☀', '⚑', '✎', 'Ω',
];

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const rec = raw ? JSON.parse(raw) : null;
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

function writeCache(rec) {
  try {
    if (rec) localStorage.setItem(CACHE_KEY, JSON.stringify(rec));
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* private mode — the app still renders, just without the cache */ }
}

/** Called on sign-out and account deletion. Leaving a previous account's avatar
 *  cached would show user A's face to user B on a shared device. */
export function clearAvatarCache() {
  writeCache(null);
}

/** The signed-in user's profile row, or null. Never throws. */
export async function loadProfile() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return null;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_kind, avatar_glyph, avatar_color, updated_at')
      .eq('id', uid)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Write the editable fields. Only the keys passed are touched, so saving a
 * glyph does not blank a name the user set on another device.
 */
export async function saveProfile(patch) {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) throw new Error('not-signed-in');

  const row = { id: uid, updated_at: new Date().toISOString() };
  if (patch.fullName !== undefined) row.full_name = patch.fullName?.trim() || null;
  if (patch.avatarKind !== undefined) row.avatar_kind = patch.avatarKind || null;
  if (patch.avatarGlyph !== undefined) row.avatar_glyph = patch.avatarGlyph || null;
  if (patch.avatarColor !== undefined) row.avatar_color = patch.avatarColor || null;

  // UPDATE, not upsert.
  //
  // `profiles` carries exactly two policies — select-own and update-own. There
  // is no INSERT policy, and `.upsert()` compiles to `INSERT … ON CONFLICT`,
  // which Postgres checks against the INSERT policy *even when the conflict
  // path resolves to an update*. So the upsert failed with "new row violates
  // row-level security policy" for every user, every time. Caught on-device.
  //
  // Update-only is also the correct shape rather than merely the working one:
  // a signup trigger owns row creation (593 of 594 accounts have a row), so a
  // client that could INSERT here would be able to forge a profile.
  const { data, error } = await supabase
    .from('profiles')
    .update(row)
    .eq('id', uid)
    .select('id');
  if (error) throw error;
  // An update that matches nothing is not success. One account in the table has
  // no profile row, and silently doing nothing would look exactly like saving.
  if (!data || data.length === 0) throw new Error('no-profile-row');

  // The name also lives in auth user_metadata, which is what `avatarInitials`
  // reads across all three apps. Keeping them in step is what stops the avatar
  // disagreeing with itself between StudyDesk, NCC and LimeLog.
  if (patch.fullName !== undefined) {
    try {
      await supabase.auth.updateUser({ data: { full_name: patch.fullName?.trim() || null } });
    } catch { /* the profiles row is the one that matters; metadata is a mirror */ }
  }
  return true;
}

/**
 * Re-encode and upload a chosen file, then switch the profile to 'image'.
 *
 * `replacingBytes` is passed so overwriting an existing avatar is a net-zero
 * quota change rather than counting twice.
 *
 * @throws {Error} `.code` of 'bad-type' | 'decode-failed' | 'too-large' |
 *                 'quota-exceeded' | 'not-signed-in'
 */
export async function uploadAvatar(file) {
  // Encode FIRST. It strips EXIF and enforces the size ceiling before anything
  // leaves the device, so a rejected upload costs no bandwidth and no GPS
  // coordinates are ever transmitted.
  const blob = await encodeAvatar(file);

  const prior = readCache();
  const { path } = await uploadForUser({
    bucket: AVATAR_BUCKET,
    relativePath: AVATAR_FILE,
    blob,
    contentType: 'image/webp',
    // Fixed filename, so this MUST upsert — otherwise the second avatar a user
    // picks would collide with their first.
    upsert: true,
    replacingBytes: prior?.size || 0,
  });

  await saveProfile({ avatarKind: 'image' });
  // Drop the cached URL: the path is unchanged but the bytes are not, and a
  // stale signed URL would serve the old face until it expired.
  writeCache(null);
  return path;
}

/** Remove the object and fall back to whatever the user's glyph/initials say. */
export async function removeAvatar(kindAfter = 'initials') {
  try {
    await removeForUser(AVATAR_BUCKET, AVATAR_FILE);
  } catch { /* already gone is success for our purposes */ }
  await saveProfile({ avatarKind: kindAfter });
  writeCache(null);
}

/**
 * What to actually render.
 *
 * Returns `{ kind, glyph, color, url }`. `kind` is what can be honoured NOW,
 * which is not always what the profile asked for — if the image cannot be
 * fetched (offline, expired, deleted server-side) this returns the glyph or
 * initials instead of a broken image.
 */
export async function resolveAvatar(profile) {
  const wanted = profile?.avatar_kind || 'initials';
  const glyph = profile?.avatar_glyph || null;
  const color = profile?.avatar_color || null;

  if (wanted !== 'image') {
    return { kind: wanted === 'glyph' && glyph ? 'glyph' : 'initials', glyph, color, url: null };
  }

  const cached = readCache();
  const fresh = cached
    && cached.userId === profile?.id
    && cached.url
    && Date.now() < (cached.fetchedAt || 0) + URL_TTL_MS;
  if (fresh) return { kind: 'image', glyph, color, url: cached.url };

  const url = await signedUrlForUser(AVATAR_BUCKET, AVATAR_FILE, { userId: profile?.id });
  if (!url) {
    // Offline, or the object is gone. Degrade rather than render a broken img.
    // The cached URL, if any, is deliberately kept: it may work again shortly,
    // and dropping it would mean re-signing on every failed render.
    if (cached?.url) return { kind: 'image', glyph, color, url: cached.url };
    return { kind: glyph ? 'glyph' : 'initials', glyph, color, url: null };
  }

  writeCache({ userId: profile?.id, url, fetchedAt: Date.now(), size: cached?.size || 0 });
  return { kind: 'image', glyph, color, url };
}
