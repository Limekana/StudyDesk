import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { startSessionBoot } from './sessionBoot.js';
import { tokenUserId } from './deviceOwner.js';

// v1.18.1 (StudyDesk#142) — offline with an expired access token, getSession()
// took ~51 s and then answered null, and App showed AuthGate. These pin the
// head start, the stored-session fallback, and the rule that "could not ask"
// never signs anyone out.

const STORED = { access_token: 'old', refresh_token: 'r', user: { id: 'u-1' } };
const FRESH = { access_token: 'new', refresh_token: 'r2', user: { id: 'u-1' } };

function harness({ answer, stored = null, inherited = null }) {
  let listener = null;
  const applied = [];
  const auth = {
    onAuthStateChange(cb) {
      listener = cb;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    getSession: () => answer,
  };
  const boot = startSessionBoot({
    auth,
    readStoredSession: async () => stored,
    inherit: async () => inherited,
    apply: (s, event) => applied.push([event, s]),
  });
  return { applied, boot, emit: (event, s) => listener(event, s) };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startSessionBoot', () => {
  it('uses getSession when it answers inside the head start', async () => {
    const h = harness({ answer: Promise.resolve({ data: { session: FRESH }, error: null }) });
    await vi.runAllTimersAsync();
    expect(h.applied).toEqual([['GET_SESSION', FRESH]]);
  });

  it('opens on the stored session while the refresh runs, then takes the real answer', async () => {
    const d = deferred();
    const h = harness({ answer: d.promise, stored: STORED });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.applied).toEqual([['STORED_SESSION', STORED]]);
    d.resolve({ data: { session: FRESH }, error: null });
    await vi.runAllTimersAsync();
    expect(h.applied.at(-1)).toEqual(['GET_SESSION', FRESH]);
  });

  it('keeps the stored session when the refresh fails on the network, and ignores INITIAL_SESSION null', async () => {
    const d = deferred();
    const h = harness({ answer: d.promise, stored: STORED });
    await vi.advanceTimersByTimeAsync(1500);
    h.emit('INITIAL_SESSION', null);
    d.resolve({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });
    await vi.runAllTimersAsync();
    expect(h.applied).toEqual([['STORED_SESSION', STORED]]);
  });

  it('keeps the stored session when the network failure comes back inside the head start', async () => {
    const h = harness({ answer: Promise.resolve({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) }), stored: STORED });
    await vi.runAllTimersAsync();
    expect(h.applied).toEqual([['STORED_SESSION', STORED]]);
  });

  it('signs out on a real answer (refresh token rejected), after trying NCC', async () => {
    const d = deferred();
    const h = harness({ answer: d.promise, stored: STORED });
    await vi.advanceTimersByTimeAsync(1500);
    d.resolve({ data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') });
    await vi.runAllTimersAsync();
    expect(h.applied.at(-1)).toEqual(['GET_SESSION', null]);
  });

  it('adopts an inherited session when nobody is stored', async () => {
    const h = harness({ answer: Promise.resolve({ data: { session: null }, error: null }), inherited: FRESH });
    await vi.runAllTimersAsync();
    expect(h.applied).toEqual([['GET_SESSION', FRESH]]);
  });

  it('honours SIGNED_OUT while unverified', async () => {
    const d = deferred();
    const h = harness({ answer: d.promise, stored: STORED });
    await vi.advanceTimersByTimeAsync(1500);
    h.emit('SIGNED_OUT', null);
    expect(h.applied.at(-1)).toEqual(['SIGNED_OUT', null]);
  });

  it('does nothing after cancel', async () => {
    const d = deferred();
    const h = harness({ answer: d.promise, stored: STORED });
    h.boot.cancel();
    await vi.advanceTimersByTimeAsync(1500);
    d.resolve({ data: { session: FRESH }, error: null });
    await vi.runAllTimersAsync();
    expect(h.applied).toEqual([]);
  });
});

describe('tokenUserId (limecore#59 §1)', () => {
  it('reads sub from a JWT payload, and null for junk', () => {
    const payload = btoa(JSON.stringify({ sub: 'user-b', role: 'authenticated' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(tokenUserId(`h.${payload}.s`)).toBe('user-b');
    expect(tokenUserId('not-a-jwt')).toBeNull();
    expect(tokenUserId(undefined)).toBeNull();
  });
});

describe('claimForUser (limecore#59 §1)', () => {
  const store = new Map();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adopts unowned data, keeps the same account, and asks for a wipe on a different one', async () => {
    const { claimForUser, readOwner, clearOwner } = await import('./deviceOwner.js');
    expect(claimForUser('user-a')).toBe(false); // first sign-in or guest data
    expect(readOwner()).toBe('user-a');
    expect(claimForUser('user-a')).toBe(false); // same account again
    expect(claimForUser('user-b')).toBe(true); // A's data, B signing in
    expect(readOwner()).toBe('user-b');
    clearOwner(); // explicit sign-out wiped the data
    expect(claimForUser('user-c')).toBe(false);
    expect(claimForUser(undefined)).toBe(false);
  });
});

describe('startSessionBoot: races (review of the first version)', () => {
  it('calls inherit only on a real "no session" answer', async () => {
    const inherit = vi.fn(async () => null);
    let listener;
    startSessionBoot({
      auth: { onAuthStateChange: (cb) => { listener = cb; return { data: { subscription: { unsubscribe() {} } } }; }, getSession: () => Promise.resolve({ data: { session: null }, error: null }) },
      readStoredSession: async () => null,
      inherit,
      apply: () => {},
    });
    await vi.runAllTimersAsync();
    expect(inherit).toHaveBeenCalledTimes(1);
    expect(listener).toBeTypeOf('function');
  });

  it('a sign-in made while the auto-inherit runs wins over it', async () => {
    let finishInherit;
    let listener;
    const applied = [];
    startSessionBoot({
      auth: { onAuthStateChange: (cb) => { listener = cb; return { data: { subscription: { unsubscribe() {} } } }; }, getSession: () => Promise.resolve({ data: { session: null }, error: null }) },
      readStoredSession: async () => null,
      inherit: () => new Promise((r) => { finishInherit = r; }),
      apply: (s, e) => applied.push([e, s?.user?.id ?? null]),
    });
    await vi.advanceTimersByTimeAsync(10);
    listener('SIGNED_IN', { user: { id: 'user-b' } });
    finishInherit({ user: { id: 'user-a' } });
    await vi.runAllTimersAsync();
    expect(applied).toEqual([['SIGNED_IN', 'user-b']]);
  });

  it('after a local-only sign-out, a refresh that lands late does not sign the user back in', async () => {
    const d = deferred();
    let listener;
    const applied = [];
    const boot = startSessionBoot({
      auth: { onAuthStateChange: (cb) => { listener = cb; return { data: { subscription: { unsubscribe() {} } } }; }, getSession: () => d.promise },
      readStoredSession: async () => STORED,
      inherit: async () => null,
      apply: (s, e) => applied.push([e, s?.user?.id ?? null]),
    });
    await vi.advanceTimersByTimeAsync(1500);
    boot.holdSignedOut(true);
    // The refresh that was in flight finally succeeds.
    listener('TOKEN_REFRESHED', FRESH);
    d.resolve({ data: { session: FRESH }, error: null });
    await vi.runAllTimersAsync();
    expect(applied).toEqual([['STORED_SESSION', 'u-1']]);
    // Once the sign-out call settled, a deliberate sign-in is accepted again.
    boot.holdSignedOut(false);
    listener('SIGNED_IN', FRESH);
    expect(applied.at(-1)).toEqual(['SIGNED_IN', 'u-1']);
  });
});
