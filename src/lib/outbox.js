// ── Offline outbox queue ─────────────────────────────────────────────────────
//
// Pre-v1.3 pattern: dispatch local action, fire sync call, flash on failure.
// If the device was offline at the moment the sync call ran, the change was
// gone — `sync.js` calls used `await supabase.from(...)`, which surfaces the
// error to the catch block and leaves nothing queued for later. The local
// state stayed correct but Supabase never received the change.
//
// v1.3 pattern (this file): every cross-device-relevant mutation goes through
// `enqueue()`. The outbox persists the operation to localStorage, then
// immediately tries to drain. If the device is offline OR the network call
// fails, the item stays in the queue. Drain re-runs on:
//   1. `window` "online" event (network restored)
//   2. `document` "visibilitychange" → visible (app foregrounded — Capacitor
//      bridges Android's onResume into the WebView's visibility events)
//   3. App-level mount useEffect (every cold start)
//   4. Successful auth sign-in (the post-sign-in pull runs after drain)
//   5. Manual "Retry now" button in Settings
//
// All sync.js operations are idempotent UPSERTs (or DELETEs by id), so a
// retry that races with a successful first attempt is a safe no-op.
//
// ── Ordering (rewritten v1.12 Item 1, issue #38) ───────────────────────────
// This file used to say: "the outbox does NOT guarantee ordering across kinds
// — the drain processes all items in oldest-first order so practical ordering
// holds for the same-row case." That justification did not cover the case that
// actually broke: a subject and its exam are DIFFERENT KINDS joined by a
// foreign key, and oldest-first says nothing useful about them. If the child
// is queued and the parent is not, the child fails `exams_subject_id_fkey`
// forever.
//
// The drain is now ordered by dependency rank (parents first) and, critically,
// no longer stops at the first failure. See `KIND_RANK` and `drain()`.
//
// Storage shape (localStorage `studydesk-outbox`):
//   [
//     { id, createdAt, kind, payload, attempts, lastAttemptAt?, lastError? }
//   ]
//
// Items are removed on success. Items hitting MAX_ATTEMPTS surface as a hard
// error (the Settings panel shows the lastError; user can manually retry or
// the next mutation triggers another drain). We never silently drop.

import * as sync from './sync.js';
import { writeJson } from './localStore.js';

const STORAGE_KEY = 'studydesk-outbox';
const META_KEY = 'studydesk-outbox-meta'; // { lastSuccessAt }
const MAX_ATTEMPTS = 5;

// The item `drain` is currently awaiting, if any. See `enqueue`.
let inFlightId = null;
const CHANGE_EVENT = 'studydesk-outbox-change';

// ── Storage helpers ────────────────────────────────────────────────────────

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveItems(items) {
  // v1.13 Item 1a. This used to be a console.error and a shrug, with the
  // comment "quota-exceeded is unrecoverable for the outbox". That is true as
  // far as it goes and it buried the more important half: the outbox shares
  // one origin quota with `studydesk-v1`, so an outbox that cannot be written
  // is a strong signal that the STATE SNAPSHOT is about to fail too — and
  // that one is the user's data.
  //
  // An offline stretch is what inflates this file, and an offline user is
  // exactly the person whose rows exist nowhere else. Routing through
  // `writeJson({critical: true})` means the first of the two writes to hit
  // the ceiling raises the alarm, rather than each failing quietly in turn.
  const { ok, error } = writeJson(STORAGE_KEY, items, { critical: true });
  if (!ok) {
    console.error('[outbox] storage write failed:', error);
  }
  // v1.3.1 — invalidate the cached snapshot so the next getStatus() rebuild
  // reflects this write. Without this, useSyncExternalStore subscribers
  // would re-render but read the stale cached object.
  cachedStatus = null;
  // Notify listeners (Settings panel) that the count may have changed.
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch { /* SSR / non-window environments */ }
}

function loadMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  // Bookkeeping, not user data — a lost `lastSuccessAt` costs a wrong
  // timestamp in Settings and nothing else, so this one stays non-critical
  // and must never raise the alarm on its own.
  writeJson(META_KEY, meta);
  // v1.3.1 — same cache-invalidation as saveItems.
  cachedStatus = null;
}

function makeId() {
  // Cheap unique-ish ID — outbox items live briefly; collision risk is nil
  // and we don't need crypto strength here.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Enqueue a mutation for upstream sync. Triggers an immediate drain attempt.
 *  Returns synchronously — does NOT block on the drain (which is async + may
 *  retry over multiple network events). Failure surfaces via the outbox
 *  metadata + Settings panel; callers don't need to await.
 *
 *  @param {string} kind  One of the keys in KIND_DISPATCH below.
 *  @param {object} payload  Operation-specific args; matches the sync.js fn signature.
 */
/**
 * The identity of the FACT an item represents — not the identity of the item.
 *
 * `${kind}::${payload.id}` for anything row-shaped, which is every kind
 * reconcile can produce. Kinds without a row id (`record_app_open`,
 * `archive_semester`) return null and are appended as before; both are
 * bounded by other means.
 */
function identityOf(kind, payload) {
  const id = payload?.id;
  return typeof id === 'string' && id ? `${kind}::${id}` : null;
}

/**
 * Queue one mutation.
 *
 * ── Why this COALESCES rather than always appending ──────────────────────
 *
 * v1.13 review, blocker 1. `reconcileUnsynced` runs on every pull, and
 * `sync.startRealtime(doPull)` makes pull the realtime handler too — so it
 * runs on every remote change, not just at launch. It re-enqueues any row it
 * finds locally but not remotely.
 *
 * A row that can never push is exactly such a row, permanently. It burns its
 * five attempts, quarantines, and is then re-manufactured as a BRAND NEW item
 * by the next pull, forever. The queue grows without bound in the same
 * localStorage origin as the state blob — which is the durability failure
 * this very release exists to fix. v1.12 had the shape for four tables;
 * Item 1a widened reconcile to ten, so the leak widened with it.
 *
 * Coalescing on the fact's identity bounds the queue at one item per row per
 * kind, whatever reconcile does. It is safe because every upsert here carries
 * a SNAPSHOT rather than a patch — that contract is stated on the kinds
 * themselves — so replacing a pending payload with a newer one loses nothing
 * and is strictly more correct than pushing the stale copy first.
 *
 * `attempts` and `quarantined` are deliberately PRESERVED across a coalesce.
 * Refreshing the payload must not silently revive a stuck item and re-fail
 * it; the row stays quarantined, stays counted by `getStatus`, and carries
 * the newest data for when the user presses Retry.
 *
 * The one item never coalesced onto is the one currently in flight: `drain`
 * removes it by item id on success, so replacing its payload mid-await would
 * drop the newer edit with no path back.
 */
export function enqueue(kind, payload) {
  if (!KIND_DISPATCH[kind]) {
    console.error('[outbox] unknown kind:', kind);
    return;
  }
  const items = loadItems();
  const key = identityOf(kind, payload);
  if (key) {
    const at = items.findIndex(
      (it) => it.id !== inFlightId && identityOf(it.kind, it.payload) === key,
    );
    if (at !== -1) {
      items[at] = { ...items[at], payload };
      saveItems(items);
      void drain();
      return;
    }
  }
  items.push({
    id: makeId(),
    createdAt: new Date().toISOString(),
    kind,
    payload,
    attempts: 0,
  });
  saveItems(items);
  // Fire-and-forget drain. Single-flight inside drain() coalesces overlapping
  // calls so this is safe even if many enqueues land in quick succession.
  void drain();
}

// ── Dependency ranking ─────────────────────────────────────────────────────
//
// Lower rank drains first. This encodes foreign keys, nothing else: a row that
// something else points AT must be written before the row that points at it.
// Everything unlisted is rank 1, which is the safe default — a child.
//
// Rank 0 is the set of parents:
//   `upsert_subject`  — `grades`, `exams`, `assignments`, `study_actions`,
//                       `timetable_entries`, `planned_sessions` all carry
//                       `subject_id`. `exams`/`assignments` are ON DELETE
//                       CASCADE, and their FK is what issue #38 reported.
//   `upsert_term`     — `timetable_entries.term_id`, and `academic_terms`
//                       self-references for the Year > Semester > Jakso tree.
//   `log_session`     — `planned_sessions.fulfilled_by` points at
//                       `study_sessions`. CalendarView's `logPlan` already
//                       relied on oldest-first for this; ranking makes the
//                       guarantee explicit instead of incidental.
//
// Sort stability matters and is relied on: within a rank the original FIFO
// order is preserved (Array.prototype.sort is stable, ES2019+), so two edits
// to the same row still apply in the order the user made them.
const KIND_RANK = {
  upsert_subject: 0,
  upsert_term: 0,
  log_session: 0,
};

function rankOf(kind) {
  return KIND_RANK[kind] ?? 1;
}

/** Dependency-ordered copy of `items`. Does not mutate the input. */
function orderForDrain(items) {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rankOf(a.item.kind) - rankOf(b.item.kind) || a.i - b.i)
    .map(({ item }) => item);
}

let draining = false;

/** Process pending items in dependency order. Coalesces concurrent calls via
 *  the `draining` flag — a second invocation while one is in-flight returns
 *  immediately.
 *
 *  **Does not stop at the first failure.** The previous implementation did,
 *  which turned one unsatisfiable item into a frozen queue: the head burned
 *  its five attempts on every drain, rotated to the back, and the next
 *  orphaned child failed identically. Issue #38 is that carousel — the
 *  reporter watched the failing kind rotate `exams` → `assignments` while
 *  nothing at all synced. One bad item must not block unrelated mutations.
 *
 *  @param {object}  [opts]
 *  @param {boolean} [opts.force]  Clear quarantine + reset attempts first.
 *                                 The manual "Retry now" button — an explicit
 *                                 user request to try everything again.
 *  Returns the new queue depth so callers can decide whether to flash a
 *  result message. */
export async function drain(opts = {}) {
  if (draining) return loadItems().length;
  // Skip if offline — items stay queued. `online` event will re-trigger.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return loadItems().length;
  }
  draining = true;
  try {
    if (opts.force) {
      saveItems(loadItems().map((i) => ({ ...i, attempts: 0, quarantined: false })));
    }

    // Snapshot which items this pass will attempt, in dependency order.
    // Anything enqueued mid-pass is picked up by the next drain rather than
    // extending this one indefinitely.
    const planned = orderForDrain(loadItems()).map((i) => i.id);

    // The FIRST failure of the pass, not the last. With dependency ordering
    // the first failure is the closest thing to a root cause the queue can
    // observe — a failing parent explains its children, never the reverse.
    // Surfacing only `lastError` is why #38 was reported as "exams" when the
    // subject was the actual problem.
    let firstError = null;
    let firstErrorKind = null;

    for (const id of planned) {
      const items = loadItems();
      const item = items.find((i) => i.id === id);
      // Gone — a concurrent clear() (sign-out) or a parallel drain took it.
      if (!item) continue;
      // Quarantined items are skipped until an explicit forced retry. They
      // are NOT dropped: silent data loss is still worse than a stuck item,
      // and the Settings panel surfaces the count.
      if (item.quarantined) continue;

      const handler = KIND_DISPATCH[item.kind];
      if (!handler) {
        // Unknown kind — drop it (came from an older app version or a typo).
        console.error('[outbox] dropping item with unknown kind:', item.kind);
        saveItems(loadItems().filter((i) => i.id !== id));
        continue;
      }

      try {
        // Marked in flight so a concurrent `enqueue` appends instead of
        // replacing this item's payload — the success path below removes it
        // by id, which would take a newer edit with it.
        inFlightId = id;
        await handler(item.payload);
        saveItems(loadItems().filter((i) => i.id !== id));
        saveMeta({ ...loadMeta(), lastSuccessAt: new Date().toISOString() });
      } catch (e) {
        const errMsg = (e && e.message) || String(e);
        const attempts = (item.attempts || 0) + 1;
        // At the ceiling an item is quarantined rather than rotated to the
        // back. Rotating is what produced #38's confusing carousel: the item
        // never left the queue, so it re-failed on every subsequent drain and
        // kept overwriting `lastError` with whichever child ran last.
        const quarantined = attempts >= MAX_ATTEMPTS;
        saveItems(loadItems().map((i) => (
          i.id === id
            ? { ...i, attempts, quarantined, lastAttemptAt: new Date().toISOString(), lastError: errMsg }
            : i
        )));
        if (!firstError) { firstError = errMsg; firstErrorKind = item.kind; }
      } finally {
        inFlightId = null;
      }
    }

    saveMeta({
      ...loadMeta(),
      lastError: firstError,
      lastErrorKind: firstErrorKind,
      lastErrorAt: firstError ? new Date().toISOString() : loadMeta().lastErrorAt || null,
    });
  } finally {
    draining = false;
  }
  return loadItems().length;
}

// v1.3.1 — cached snapshot. `useSyncExternalStore` requires getSnapshot to
// return a stable reference between actual state changes; returning a fresh
// object literal every call caused an infinite render loop (each call
// produced a new `===`-different object, React re-rendered, called
// getStatus again, repeat). Invalidated by saveItems/saveMeta/clear.
let cachedStatus = null;

/** Current queue depth + meta for the Settings panel.
 *
 *  Stable-reference contract: returns the same object reference until the
 *  underlying state changes (via any saveItems/saveMeta/clear write).
 *  Critical for useSyncExternalStore — see comment on `cachedStatus`. */
export function getStatus() {
  if (cachedStatus) return cachedStatus;
  const items = loadItems();
  const meta = loadMeta();
  cachedStatus = {
    pending: items.length,
    lastSuccessAt: meta.lastSuccessAt || null,
    lastError: meta.lastError || null,
    lastErrorAt: meta.lastErrorAt || null,
    // Which kind produced the first failure of the last pass. `lastError`
    // alone reads as "exams are broken" when the real answer is "the course
    // those exams hang off never reached the server" — see #38.
    lastErrorKind: meta.lastErrorKind || null,
    // Oldest pending item — useful UI hint ("waiting since 5m ago").
    oldestEnqueuedAt: items[0]?.createdAt || null,
    // Quarantined items — past the attempt ceiling, skipped by ordinary
    // drains, retried only when the user explicitly asks. Surfaced as a
    // needs-attention count rather than left to rotate invisibly.
    stuck: items.filter((i) => i.quarantined).length,
    // v1.13 Item 1a — the count alone said "something is stuck" and nothing
    // about WHAT, which is not enough to act on and not enough to report.
    // These two answer "what stopped, and since when", so Settings can say it
    // in words and a user can tell us something useful when they write in.
    //
    // Kinds are de-duplicated: five failing exams are one problem, and a list
    // that repeats a kind five times reads as five.
    stuckKinds: Array.from(new Set(items.filter((i) => i.quarantined).map((i) => i.kind))),
    stuckSince: items
      .filter((i) => i.quarantined)
      .map((i) => i.createdAt)
      .sort()[0] || null,
  };
  return cachedStatus;
}

/** Clear the outbox. Called on auth sign-out — we don't want to retry the
 *  signed-out user's pending writes as the next signed-in user. */
export function clear() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(META_KEY);
  } catch { /* ignore */ }
  // v1.3.1 — invalidate cached snapshot (same reason as saveItems).
  cachedStatus = null;
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch { /* ignore */ }
}

/** Subscribe to queue state changes. Returns an unsubscriber. Used by the
 *  Settings panel via useSyncExternalStore-style polling. Fires on every
 *  enqueue, drain step, and clear. */
export function subscribe(listener) {
  if (typeof window === 'undefined') return () => {};
  const handler = () => listener();
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// ── Kind dispatch table ────────────────────────────────────────────────────
//
// Each kind maps to the sync.js function it represents. The payload shape
// here MUST match the sync.js function signature (drain spreads it via
// `handler(item.payload)`).
//
// New mutation type? Add a kind here AND update the call sites in App.jsx /
// GradesView.jsx / SessionsView.jsx to use `enqueue` instead of a direct
// sync.* call. Unknown kinds in the queue get dropped during drain — that
// means version downgrades are non-destructive (old kinds disappear) but
// re-installs that wipe localStorage lose any pending items, which is the
// only path to true data loss in this design.

const KIND_DISPATCH = {
  // v1.10 - feedback. Idempotent on retry via the client-supplied id; see
  // sync.submitFeedback for why it is an INSERT rather than an UPSERT.
  submit_feedback: (p) => sync.submitFeedback(p),
  upsert_subject: (p) => sync.upsertSubject(p),
  delete_subject: (p) => sync.deleteSubject(p.id),
  upsert_grade: (p) => sync.upsertGrade(p),
  delete_grade: (p) => sync.deleteGrade(p.id),
  log_session: (p) => sync.logStudySession(p),
  update_session: (p) => sync.updateStudySession(p),
  delete_session: (p) => sync.deleteStudySession(p.id),
  // v1.7 (StudyDesk#6) — assignments, exams and manual to-dos. Upserts carry
  // the whole entity rather than a patch, so a retry after a later local edit
  // still converges: the queued payload is a snapshot, and the newest write
  // wins on updated_at like everything else here.
  upsert_assignment: (p) => sync.upsertAssignment(p),
  delete_assignment: (p) => sync.deleteAssignment(p.id),
  upsert_exam: (p) => sync.upsertExam(p),
  delete_exam: (p) => sync.deleteExam(p.id),
  upsert_action: (p) => sync.upsertAction(p),
  delete_action: (p) => sync.deleteAction(p.id),
  // Semester archive/restore: stored as a single batch op so a retry doesn't
  // re-fire one course per item if the user archived a 6-course semester.
  // `courses` snapshot is captured at enqueue time so the batch is stable.
  archive_semester: (p) => sync.archiveSemester(p.courses, p.semester),
  restore_semester: (p) => sync.restoreSemester(p.courses, p.semester),
  // v1.10 — planned study blocks, the academic-term tree and the weekly
  // timetable. Same snapshot-not-patch contract as the assignments above.
  upsert_planned: (p) => sync.upsertPlannedSession(p),
  delete_planned: (p) => sync.deletePlannedSession(p.id),
  upsert_term: (p) => sync.upsertTerm(p),
  // Carries the descendant ids resolved at enqueue time, so a retry
  // soft-deletes exactly the subtree that existed when the user pressed
  // delete rather than re-walking a tree that has since changed.
  delete_term: (p) => sync.deleteTerm(p),
  upsert_timetable: (p) => sync.upsertTimetableEntry(p),
  delete_timetable: (p) => sync.deleteTimetableEntry(p.id),
  // Attachment DELETE queues; attachment UPLOAD deliberately does not. A File
  // cannot survive the JSON round-trip this queue is persisted through — it
  // would serialise to `{}` and a retry would push an empty object under the
  // user's filename. Uploads therefore require connectivity and report their
  // own failure. See `uploadAttachment` in sync.js.
  delete_attachment: (p) => sync.deleteAttachment(p),
  // Non-study blockers — training, clubs, shifts.
  upsert_commitment: (p) => sync.upsertCommitment(p),
  delete_commitment: (p) => sync.deleteCommitment(p.id),
  // v1.13 Tier 2 — lesson attendance (#31).
  upsert_attendance: (p) => sync.upsertAttendance(p),
  delete_attendance: (p) => sync.deleteAttendance(p.id),
  // v1.13 Item 1b — the notebook. A note is queued like any other entity;
  // its ATTACHMENT UPLOAD is not, for the same reason assignment uploads are
  // not — a File cannot survive the JSON round trip this queue is persisted
  // through. Only the delete queues.
  upsert_note: (p) => sync.upsertNote(p),
  delete_note: (p) => sync.deleteNote(p.id),
  upsert_note_attachment: (p) => sync.upsertNoteAttachment(p),
  delete_note_attachment: (p) => sync.deleteNoteAttachment(p),
  // v1.12 Item 0 — one row per user per app per day, written on foreground.
  // Queued rather than pushed directly for two reasons: a cold start can
  // foreground before `adoptSession()` has resolved, and RLS would reject the
  // write with no session; and the phone is often offline at exactly the
  // moment the app comes up. Both resolve into a retry rather than a lost day.
  record_app_open: (p) => sync.recordAppOpen(p),
};
