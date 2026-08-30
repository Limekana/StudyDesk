// v1.12 Item 9 — the shared per-user storage module.
//
// **Written as the reusable module on purpose, not as an avatar one-off.**
// `v1.13`'s Notebook needs the identical pattern, and `assignment_attachments`
// has no quota either. One implementation, three buckets.
//
// **Supabase has no native per-user quota.** There is no setting for it, so the
// only place it can exist is a check-before-upload that sums what the user
// already has. That is what `usedBytes` does. It is not a security boundary —
// a determined client can skip it — it is a cost control, and the real ceiling
// is the bucket's own `file_size_limit`, which the server enforces.
//
// **Path convention: `{user_id}/…`.** Segment 1 is the owner, because that is
// what every storage policy in this project keys on:
//     (storage.foldername(name))[1] = auth.uid()::text
// It is load-bearing, not cosmetic. A path that does not start with the user's
// id is refused by RLS.

import { supabase } from './supabase.js';

/** Free-tier storage is 1 GB total. 5 MB per user across all buckets is far
 *  more than the avatar (256 KB) needs and leaves headroom for Notebook
 *  attachments later, while keeping ~200 heavy users inside the free tier. */
export const DEFAULT_USER_QUOTA_BYTES = 5 * 1024 * 1024;

async function currentUserId() {
  const { data: { session } } = await supabase.auth.getSession();
  const id = session?.user?.id;
  if (!id) throw new Error('not-signed-in');
  return id;
}

/**
 * Bytes this user currently occupies in one bucket.
 *
 * Lists their own folder only — RLS would refuse anything else, and listing the
 * bucket root would be both slower and a smell.
 */
export async function usedBytes(bucket, userId) {
  const uid = userId || (await currentUserId());
  let total = 0;
  const walk = async (prefix) => {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw error;
    for (const entry of data || []) {
      // A folder comes back with a null id; a file carries metadata.size.
      if (entry.id === null) {
        await walk(`${prefix}/${entry.name}`);
      } else {
        total += Number(entry.metadata?.size) || 0;
      }
    }
  };
  await walk(uid);
  return total;
}

/**
 * Upload a blob to `{user_id}/{relativePath}`, refusing to exceed the quota.
 *
 * @param {object}  opts
 * @param {string}  opts.bucket
 * @param {string}  opts.relativePath  path BELOW the user folder; the user id
 *                                     prefix is added here so no caller can
 *                                     forget it and trip RLS.
 * @param {Blob}    opts.blob
 * @param {string}  opts.contentType
 * @param {boolean} [opts.upsert]      true for a fixed-filename object.
 * @param {number}  [opts.quotaBytes]
 * @param {number}  [opts.replacingBytes] size of the object being overwritten,
 *                  so replacing a file does not count twice against the quota.
 * @returns {Promise<{path: string, size: number, used: number}>}
 */
export async function uploadForUser({
  bucket,
  relativePath,
  blob,
  contentType,
  upsert = false,
  quotaBytes = DEFAULT_USER_QUOTA_BYTES,
  replacingBytes = 0,
}) {
  if (!bucket || !relativePath || !blob) throw new Error('bucket, relativePath and blob are required');
  const uid = await currentUserId();

  const used = await usedBytes(bucket, uid);
  // `replacingBytes` matters for the fixed-filename case: overwriting a 200 KB
  // avatar with another 200 KB avatar is a net zero, and counting the new one
  // on top of the old would refuse an upload that costs nothing.
  const projected = used - Math.max(0, replacingBytes) + blob.size;
  if (projected > quotaBytes) {
    const e = new Error('quota-exceeded');
    e.code = 'quota-exceeded';
    e.used = used;
    e.quota = quotaBytes;
    throw e;
  }

  const path = `${uid}/${relativePath}`;
  const { error } = await supabase.storage.from(bucket).upload(path, blob, { contentType, upsert });
  if (error) throw error;
  return { path, size: blob.size, used: projected };
}

/** Remove one object. Safe to call when it does not exist. */
export async function removeForUser(bucket, relativePath, userId) {
  const uid = userId || (await currentUserId());
  const { error } = await supabase.storage.from(bucket).remove([`${uid}/${relativePath}`]);
  if (error && !/not.*found/i.test(error.message || '')) throw error;
}

/**
 * A time-limited URL for a private object.
 *
 * The bucket is private, so there is no public URL to construct — this is the
 * only way to render one, and it is also why an avatar cannot be enumerated or
 * hotlinked by a third party.
 */
export async function signedUrlForUser(bucket, relativePath, { expiresIn = 3600, userId } = {}) {
  const uid = userId || (await currentUserId());
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(`${uid}/${relativePath}`, expiresIn);
  if (error) return null;
  return data?.signedUrl || null;
}
