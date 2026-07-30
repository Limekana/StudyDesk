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
// retry that races with a successful first attempt is a safe no-op. The
// outbox does NOT guarantee ordering across kinds — within a kind the FIFO
// order is preserved, but the drain processes all items in oldest-first
// order so practical ordering holds for the same-row case.
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

const STORAGE_KEY = 'studydesk-outbox';
const META_KEY = 'studydesk-outbox-meta'; // { lastSuccessAt }
const MAX_ATTEMPTS = 5;
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    // Quota-exceeded is unrecoverable for the outbox — log and continue.
    // The next mutation will overwrite + try again with whatever fits.
    console.error('[outbox] storage write failed:', e);
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
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch { /* see saveItems */ }
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
export function enqueue(kind, payload) {
  if (!KIND_DISPATCH[kind]) {
    console.error('[outbox] unknown kind:', kind);
    return;
  }
  const items = loadItems();
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

let draining = false;

/** Process pending items oldest-first. Coalesces concurrent calls via the
 *  `draining` flag — a second invocation while one is in-flight returns
 *  immediately. Stops on the first persistent failure to avoid burning
 *  through the queue with the same network error.
 *
 *  Returns the new queue depth so callers can decide whether to flash a
 *  result message. */
export async function drain() {
  if (draining) return loadItems().length;
  // Skip if offline — items stay queued. `online` event will re-trigger.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return loadItems().length;
  }
  draining = true;
  try {
    while (true) {
      const items = loadItems();
      if (items.length === 0) break;
      const item = items[0];
      const handler = KIND_DISPATCH[item.kind];
      if (!handler) {
        // Unknown kind — drop it (came from an older app version or a typo).
        // Logging so we notice in dev.
        console.error('[outbox] dropping item with unknown kind:', item.kind);
        saveItems(items.slice(1));
        continue;
      }
      try {
        await handler(item.payload);
        // Success — remove from queue + bump last-success.
        saveItems(items.slice(1));
        saveMeta({ ...loadMeta(), lastSuccessAt: new Date().toISOString(), lastError: null });
      } catch (e) {
        const attempts = (item.attempts || 0) + 1;
        const errMsg = (e && e.message) || String(e);
        // Update the item in-place with attempt + error metadata.
        const updated = [
          { ...item, attempts, lastAttemptAt: new Date().toISOString(), lastError: errMsg },
          ...items.slice(1),
        ];
        // Hit the ceiling? Move to the back of the queue so subsequent items
        // can still attempt. The user can manually retry or the next mutation
        // will trigger another drain. We do NOT drop — silent data loss is
        // worse than a stuck queue surfacing in the UI.
        if (attempts >= MAX_ATTEMPTS) {
          saveItems([...updated.slice(1), updated[0]]);
        } else {
          saveItems(updated);
        }
        saveMeta({ ...loadMeta(), lastError: errMsg, lastErrorAt: new Date().toISOString() });
        // Stop the drain pass — most likely the next item would hit the
        // same error. Next trigger (online event / visibility / manual)
        // tries again.
        break;
      }
    }
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
    // Oldest pending item — useful UI hint ("waiting since 5m ago").
    oldestEnqueuedAt: items[0]?.createdAt || null,
    // Items at the attempt ceiling — surfaced as a stuck-queue warning.
    stuck: items.filter((i) => (i.attempts || 0) >= MAX_ATTEMPTS).length,
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
};
