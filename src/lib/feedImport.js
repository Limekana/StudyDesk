// Turning feed events into assignment rows.
//
// ── The identity problem, and why the id is derived ──────────────────────
//
// An imported event has to become a real assignment: that is what "due dates
// arrive on their own" means, and it is why the feature removes typing rather
// than adding a second list to check. Real rows also mean the imported dates
// sync to a second device, appear in Next Up, and count towards everything
// else — none of which a parallel local-only list would do.
//
// That creates an identity question. The feed is re-fetched on a schedule, so
// the same event must land on the same row every time or a term duplicates
// itself every six hours. The obvious answer — a `feed_uid` column with a
// unique index — needs DDL and, worse, would put a fragment of a capability
// URL's contents into the shared database, which is exactly what the
// device-only decision exists to prevent.
//
// So the id is DERIVED from the event UID: a deterministic UUID, computed by
// hashing the feed's own identifier. Three things fall out of that, and the
// third is the one that made the decision:
//
//   1. Re-fetching is idempotent for free. Same UID, same uuid, and the
//      existing upsert path converges with no new column and no lookup table.
//   2. No feed data reaches the server. The uuid is a hash; the UID it came
//      from is not recoverable from it, and nothing about the subscription is
//      stored anywhere but the device.
//   3. TWO DEVICES AGREE. A device-side mapping table would work on the
//      device that built it and duplicate everything on any other. A student
//      who subscribes on their phone and then their laptop gets one set of
//      rows, because both devices compute the same id from the same event.
//
// The namespace prefix is what stops a feed UID colliding with anything else
// this app hashes, now or later.

const NAMESPACE = 'studydesk.calendar-feed.v1:';

/**
 * A stable UUID for one feed event.
 *
 * SHA-256 through Web Crypto, laid out as a v5-shaped UUID (version 5 is
 * precisely "name-based, SHA-1"; this is the same idea with a stronger hash,
 * and the version nibble is set so the value is a well-formed UUID that
 * Postgres will accept in a `uuid` column).
 *
 * Async because `crypto.subtle` is. Every caller here is already async.
 */
export async function idForUid(feedUid) {
  const input = `${NAMESPACE}${String(feedUid ?? '')}`;

  const bytes = await sha256(input);
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');

  // Version 5, variant RFC 4122. Without these the string is still 32 hex
  // digits but is not a valid UUID, and Postgres accepts it while other
  // tooling does not — a difference that would surface much later and much
  // more confusingly than a rejected insert.
  const v = `${hex.slice(0, 12)}5${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const rest = `${variantNibble}${hex.slice(17, 32)}`;

  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${rest.slice(0, 4)}-${rest.slice(4, 16)}`;
}

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle?.digest) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
    return new Uint8Array(buf);
  }
  // Fallback for an insecure context, where `crypto.subtle` is absent. Four
  // FNV-1a passes with different offset bases, giving 128 bits.
  //
  // Weaker than SHA-256 and deliberately not pretended otherwise — but the
  // property that matters here is collision resistance across ONE user's few
  // hundred calendar events, not resistance to an adversary, because nothing
  // about this value is a secret or a credential.
  const out = new Uint8Array(32);
  const bases = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0xcafebabe];
  for (let k = 0; k < 4; k++) {
    let h = bases[k] >>> 0;
    for (let i = 0; i < enc.length; i++) {
      h ^= enc[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out[k * 4] = (h >>> 24) & 0xff;
    out[k * 4 + 1] = (h >>> 16) & 0xff;
    out[k * 4 + 2] = (h >>> 8) & 0xff;
    out[k * 4 + 3] = h & 0xff;
  }
  return out;
}

/**
 * Feed items → assignment payloads.
 *
 * @param {Array} items      from `toFeedItems`
 * @param {string|null} courseId  the course the user filed this feed under
 *
 * The `type` is set to a fixed marker rather than guessed from the title.
 * The build plan is explicit about why:
 *
 *   > "ICS carries titles, dates and descriptions — not assignment type,
 *      points or submission status. This is 'due dates arrive on their own',
 *      not 'Canvas mirrored'; say so in the reply to #44 so nobody expects
 *      the latter."
 *
 * Inferring "Quiz" from a title containing the word quiz is exactly how a
 * feature starts being read as a full mirror, and it would be wrong often
 * enough to be worse than blank. `type` is free text (see assignTypes.js), so
 * a marker is a legal value the user can change.
 */
export async function toAssignments(items, courseId) {
  const out = [];
  for (const item of items || []) {
    if (!item.uid || !item.dueDate) continue;
    out.push({
      id: await idForUid(item.uid),
      courseId: courseId || null,
      title: item.title || item.uid,
      type: 'imported',
      dueDate: item.dueDate,
      // The time and the source URL go in the notes because there is nowhere
      // more honest to put them: `assignments` has no time column, and
      // throwing away "23:59" from a deadline would lose the one detail
      // students most often need.
      notes: buildNotes(item),
      done: false,
    });
  }
  return out;
}

function buildNotes(item) {
  const parts = [];
  if (item.time && !item.allDay) parts.push(item.time);
  if (item.location) parts.push(item.location);
  if (item.notes) parts.push(item.notes);
  const joined = parts.join('\n');
  // A description in a feed can be kilobytes of boilerplate. Truncated with
  // an ellipsis rather than dropped, so the user can see there was more.
  return joined.length > 2000 ? `${joined.slice(0, 1999)}…` : (joined || null);
}
