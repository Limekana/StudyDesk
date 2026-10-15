// v1.18.1 (limecore#61) — what account deletion has to remove by hand, and
// the order it goes in.
//
// Deleting the auth user cascades to every table that references it, but not
// to Storage: `storage.objects` references only its bucket. So the avatar and
// every coursework attachment outlived the account. Every bucket keeps a
// user's files under `<user id>/…` (the policies check
// `foldername(name)[1]`), so that folder, in every bucket the project has, is
// everything to remove. The buckets are listed rather than named here, for
// the reason index.ts gives for the cascade: a list kept by hand is a thing
// you forget to update, and the failure is silent.
//
// Plain JavaScript with no Deno or npm imports, so the unit test can run it
// under Node with a stand-in client.

// Storage lists up to 1000 per call. Removal goes in smaller batches: a
// project can set a per-request delete limit below 1000.
const PAGE = 1000;
const REMOVE_BATCH = 100;

/** Every file path under `prefix`, descending into folders. Storage lists one
 *  level at a time, and reports a folder as an entry with no id. */
async function listFiles(bucket, prefix) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await bucket.list(prefix, { limit: PAGE, offset });
    if (error) throw error;
    for (const entry of data ?? []) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id == null) out.push(...(await listFiles(bucket, path)));
      else out.push(path);
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Remove every file the user has, in every bucket. Throws on the first
 *  failure, and if anything is still in a user's folder afterwards (an upload
 *  from another device meanwhile, or a path Storage did not match). Returns
 *  how many files went, per bucket. */
export async function removeUserFiles(admin, userId) {
  const { data: buckets, error } = await admin.storage.listBuckets();
  if (error) throw error;
  const removed = {};
  for (const { id } of buckets ?? []) {
    const bucket = admin.storage.from(id);
    const paths = await listFiles(bucket, userId);
    for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
      const { error: rmErr } = await bucket.remove(paths.slice(i, i + REMOVE_BATCH));
      if (rmErr) throw rmErr;
    }
    const { data: left, error: leftErr } = await bucket.list(userId, { limit: 1 });
    if (leftErr) throw leftErr;
    if (left?.length) throw new Error(`files remain in ${id}`);
    removed[id] = paths.length;
  }
  return removed;
}

/** The AI rate-limit rows keyed to the user (`user:<id>` and
 *  `user:<id>:day`). They hold a count, not content, but they name the id. */
export function rateLimitBuckets(userId) {
  return [`user:${userId}`, `user:${userId}:day`];
}

/**
 * Erase the account: the user's files, then the user (which cascades to every
 * table), then the rate-limit rows. Returns `{ ok, filesLeft }`.
 *
 * Files go first, while the user still exists to name them by. A failure there
 * is logged, with the user id, for the owner to remove by hand, and does NOT
 * stop the erasure: the user asked for their account to go, and an account
 * kept because of a storage fault is the worse failure of the two (the same
 * call the client makes, src/lib/dataRights.js). The rate-limit rows are best
 * effort after the account is gone.
 */
export async function eraseAccount(admin, userId, log = console) {
  let filesLeft = false;
  try {
    await removeUserFiles(admin, userId);
  } catch (e) {
    filesLeft = true;
    log.error('delete-account: files left, remove by hand', { userId, message: e?.message ?? String(e) });
  }
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    log.error('delete-account failed', { userId, message: delErr.message });
    return { ok: false, filesLeft };
  }
  const { error: rlErr } = await admin.from('ai_rate_limits').delete().in('bucket', rateLimitBuckets(userId));
  if (rlErr) log.error('delete-account: rate-limit rows left', { userId, message: rlErr.message });
  return { ok: true, filesLeft };
}
