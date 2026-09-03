// Assertions over the pure logic that v1.13 depends on.
//
// The repo had no committed test file before this — the assertion counts in
// the changelog were run ad hoc and thrown away, so nothing stopped a later
// edit from breaking them. This runs in `npm run lint`, uses `node:assert`
// and adds no dependency.
//
// Scope is deliberate: modules that are pure, and behaviour where being wrong
// is expensive. `reconcile.js` decides whether a user's local-only rows are
// ever pushed, and `localStore.js` decides whether a failed write is noticed.
// Both are the difference between keeping and losing somebody's work, and
// both are testable without a browser.

import assert from 'node:assert/strict';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── localStorage stub ─────────────────────────────────────────────────────
//
// A real Map behind the DOM API, plus a switchable failure mode, because the
// entire point of localStore.js is what it does when the write fails — and
// that path is unreachable with a working store.

function makeStorage({ failWith = null, failUnlessFreed = 0 } = {}) {
  const map = new Map();
  let freed = 0;
  const store = {
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      // `failUnlessFreed` models the real quota case: the write succeeds only
      // once enough recoverable bytes have been dropped. That is the retry
      // this module exists to perform, and asserting it needs a store that
      // can actually change its mind.
      if (failWith && freed < failUnlessFreed) {
        // The message must match the ERROR being simulated, not the scenario.
        // `isQuotaError` falls back to a message regex when the name and code
        // are unrecognised, so a SecurityError carrying the word "quota"
        // would be classified as a quota failure — and an earlier version of
        // this mock did exactly that, which made the non-quota assertion
        // below pass for the wrong reason.
        const e = new Error(`mock ${failWith}`);
        e.name = failWith;
        throw e;
      }
      map.set(k, String(v));
    },
    removeItem: (k) => {
      if (map.has(k)) freed += map.get(k).length;
      map.delete(k);
    },
  };
  return { store, map, freedBytes: () => freed };
}

// ── reconcile.js ──────────────────────────────────────────────────────────

const { findUnsynced } = await import('../src/lib/reconcile.js');

const COURSE = 'c0000000-0000-4000-8000-000000000001';
const emptyRemote = {
  subjects: [], exams: [], assignments: [], grades: [],
  sessions: [], plannedSessions: [], academicTerms: [],
  timetableEntries: [], commitments: [],
};

check('a local-only study session is queued — the v1.12 gap that lost five hours', () => {
  const out = findUnsynced(
    {
      courses: { [COURSE]: { id: COURSE, name: 'Physics' } },
      studySessions: [{ id: 's1', subjectId: COURSE, startedAt: '2026-09-01T10:00:00Z', durationMinutes: 300 }],
    },
    emptyRemote,
  );
  const session = out.find((o) => o.kind === 'log_session');
  assert.ok(session, 'expected a log_session item');
  assert.equal(session.payload.id, 's1');
  assert.equal(session.payload.durationMinutes, 300);
});

check('a session already on the server is not re-queued', () => {
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', startedAt: 'x', durationMinutes: 10 }] },
    { ...emptyRemote, sessions: [{ id: 's1' }] },
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a session with NO course is queued — an unassigned timer run is legitimate', () => {
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', subjectId: null, startedAt: 'x', durationMinutes: 25 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 1);
});

check('a session whose course is MISSING everywhere is held back, not orphaned', () => {
  // The course is neither local nor remote, so pushing the session would
  // manufacture the FK failure this module exists to clear.
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', subjectId: 'ghost', startedAt: 'x', durationMinutes: 25 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a session whose course is queued in the SAME batch goes too', () => {
  const out = findUnsynced(
    {
      courses: { [COURSE]: { id: COURSE, name: 'Physics' } },
      studySessions: [{ id: 's1', subjectId: COURSE, startedAt: 'x', durationMinutes: 25 }],
    },
    emptyRemote,
  );
  const kinds = out.map((o) => o.kind);
  assert.ok(kinds.includes('upsert_subject'));
  assert.ok(kinds.includes('log_session'));
  // Parent first: the outbox ranks by kind, but within a rank it drains
  // oldest-first, so emission order is what keeps the FK satisfied.
  assert.ok(kinds.indexOf('upsert_subject') < kinds.indexOf('log_session'));
});

check('a deleted session is never resurrected', () => {
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', deletedAt: '2026-09-01T00:00:00Z', startedAt: 'x', durationMinutes: 5 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a planned block is queued as planned, never as a logged session', () => {
  // An intention is not evidence. If this ever emitted `log_session`, NCC's
  // Life Score would count a plan as work done.
  const out = findUnsynced(
    { courses: {}, plannedSessions: [{ id: 'p1', subjectId: null, startsAt: 'x', durationMinutes: 50 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'upsert_planned').length, 1);
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a timetable entry waits for BOTH its term and its subject', () => {
  const withNeither = findUnsynced(
    { courses: {}, timetableEntries: [{ id: 't1', termId: 'ghost', subjectId: COURSE, weekday: 1 }] },
    emptyRemote,
  );
  assert.equal(withNeither.filter((o) => o.kind === 'upsert_timetable').length, 0);

  const withBoth = findUnsynced(
    {
      courses: { [COURSE]: { id: COURSE, name: 'Physics' } },
      academicTerms: [{ id: 'term1', level: 'jakso', name: 'J1' }],
      timetableEntries: [{ id: 't1', termId: 'term1', subjectId: COURSE, weekday: 1 }],
    },
    emptyRemote,
  );
  assert.equal(withBoth.filter((o) => o.kind === 'upsert_timetable').length, 1);
});

check('a commitment has no parent and is queued unconditionally', () => {
  const out = findUnsynced(
    { courses: {}, commitments: [{ id: 'cm1', title: 'Training', weekday: 2 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'upsert_commitment').length, 1);
});

check('a soft-deleted REMOTE row counts as present and is not re-pushed', () => {
  // The pull returns tombstones. Treating them as absent would resurrect
  // everything the user deleted on another device, on every single pull.
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', startedAt: 'x', durationMinutes: 5 }] },
    { ...emptyRemote, sessions: [{ id: 's1', deleted_at: '2026-09-01T00:00:00Z' }] },
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('empty state produces no work', () => {
  assert.equal(findUnsynced({}, emptyRemote).length, 0);
  assert.equal(findUnsynced({}, {}).length, 0);
});

// ── localStore.js ─────────────────────────────────────────────────────────

const listeners = new Set();
globalThis.window = {
  dispatchEvent: () => true,
  addEventListener: (_n, fn) => listeners.add(fn),
  removeEventListener: (_n, fn) => listeners.delete(fn),
};

const good = makeStorage();
globalThis.localStorage = good.store;

const localStore = await import('../src/lib/localStore.js');

check('a successful write stores the value and reports healthy', () => {
  const r = localStore.writeJson('studydesk-v1', { a: 1 }, { critical: true });
  assert.equal(r.ok, true);
  assert.equal(good.map.get('studydesk-v1'), '{"a":1}');
  assert.equal(localStore.storageFailure(), null);
});

check('readJson round-trips, and returns the fallback for junk', () => {
  assert.deepEqual(localStore.readJson('studydesk-v1'), { a: 1 });
  good.map.set('broken', '{not json');
  assert.deepEqual(localStore.readJson('broken', 'FALLBACK'), 'FALLBACK');
  assert.deepEqual(localStore.readJson('absent', 'FALLBACK'), 'FALLBACK');
});

check('a quota failure is REPORTED, not swallowed — the whole point', () => {
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-v1', { big: 'x' }, { critical: true });
  assert.equal(r.ok, false);
  const f = localStore.storageFailure();
  assert.ok(f, 'a critical failure must raise the health flag');
  assert.equal(f.reason, 'quota');
  assert.equal(f.key, 'studydesk-v1');
});

check('a failed write leaves the PREVIOUS value intact', () => {
  // A half-written key is worse than an old complete one. setItem leaves the
  // prior value in place on failure, and nothing here may undo that.
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  bad.map.set('studydesk-v1', '{"kept":true}');
  globalThis.localStorage = bad.store;
  localStore.writeJson('studydesk-v1', { replaced: true }, { critical: true });
  assert.equal(bad.map.get('studydesk-v1'), '{"kept":true}');
});

check('a quota failure evicts recoverable caches and retries once', () => {
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: 5 });
  bad.map.set('studydesk.avatarCache', 'aaaaaaaaaa'); // 10 chars, enough
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-v1', { a: 1 }, { critical: true });
  assert.equal(r.ok, true, 'the retry after eviction should succeed');
  assert.equal(bad.map.has('studydesk.avatarCache'), false, 'the cache should be gone');
  assert.equal(localStore.storageFailure(), null, 'a recovered write clears the flag');
});

check('user data is NEVER evicted to make room', () => {
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  bad.map.set('studydesk-v1', '{"user":"data"}');
  bad.map.set('studydesk-outbox', '[{"queued":true}]');
  globalThis.localStorage = bad.store;
  localStore.writeJson('studydesk-notebook', { x: 1 }, { critical: true });
  assert.equal(bad.map.get('studydesk-v1'), '{"user":"data"}');
  assert.equal(bad.map.get('studydesk-outbox'), '[{"queued":true}]');
});

check('a non-quota failure does not thrash the caches', () => {
  // Private mode or a storage policy. Eviction cannot fix it, and dropping
  // caches for nothing would just cost the user their avatars.
  const bad = makeStorage({ failWith: 'SecurityError', failUnlessFreed: Infinity });
  bad.map.set('studydesk.avatarCache', 'cached');
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-v1', { a: 1 }, { critical: true });
  assert.equal(r.ok, false);
  assert.equal(localStore.storageFailure().reason, 'blocked');
  assert.equal(bad.map.get('studydesk.avatarCache'), 'cached');
});

check('a NON-critical failure never raises the alarm', () => {
  globalThis.localStorage = makeStorage().store;
  localStore.writeJson('studydesk-v1', { ok: 1 }, { critical: true }); // clear the flag
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-plan-sub', 'calendar');
  assert.equal(r.ok, false);
  assert.equal(localStore.storageFailure(), null, 'losing a UI preference is not an alarm');
});

check('a value that cannot be serialised reports as itself, not as quota', () => {
  globalThis.localStorage = makeStorage().store;
  const cyclic = {};
  cyclic.self = cyclic;
  const r = localStore.writeJson('studydesk-v1', cyclic, { critical: true });
  assert.equal(r.ok, false);
  assert.equal(localStore.storageFailure().reason, 'serialise');
});

console.log(`\n${passed} assertions passed.`);
