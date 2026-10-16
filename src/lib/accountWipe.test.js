import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// v1.18.1 (limecore#59 §1) — the one wipe used by sign-out, account deletion
// and a different account signing in. Calendar feeds were missed by all three:
// a feed's ICS address is a private capability URL.

const calls = vi.hoisted(() => []);
vi.mock('./outbox.js', () => ({ clear: () => calls.push('outbox') }));
vi.mock('./entitlement.js', () => ({ clearEntitlement: () => calls.push('entitlement') }));
vi.mock('./profile.js', () => ({ clearAvatarCache: () => calls.push('avatar') }));

const store = new Map();
beforeEach(() => {
  store.clear();
  calls.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('wipeAccountLocalData', () => {
  it('clears the outbox, entitlement and avatar, and the calendar feeds and timer, and keeps device settings', async () => {
    const { wipeAccountLocalData, ACCOUNT_LOCAL_KEYS } = await import('./accountWipe.js');
    expect(ACCOUNT_LOCAL_KEYS).toEqual(expect.arrayContaining(['studydesk-calendar-feeds', 'studydesk-calendar-feed-items', 'sd-timer']));
    for (const k of ACCOUNT_LOCAL_KEYS) store.set(k, 'x');
    store.set('studydesk-grade-mode', 'custom');
    wipeAccountLocalData();
    expect(calls.sort()).toEqual(['avatar', 'entitlement', 'outbox']);
    expect(ACCOUNT_LOCAL_KEYS.filter((k) => store.has(k))).toEqual([]);
    expect(store.get('studydesk-grade-mode')).toBe('custom');
  });

  it('removes the stored state now and tells other tabs, last (StudyDesk#169)', async () => {
    const { wipeAccountLocalData } = await import('./accountWipe.js');
    const { isPageStale } = await import('./deviceOwner.js');
    store.set('studydesk-v1', '{"courses":{"a":{}}}');
    const order = [];
    const removeItem = localStorage.removeItem;
    const setItem = localStorage.setItem;
    localStorage.removeItem = (k) => { order.push(`-${k}`); removeItem(k); };
    localStorage.setItem = (k, v) => { order.push(`+${k}`); setItem(k, v); };
    wipeAccountLocalData();
    expect(store.has('studydesk-v1')).toBe(false);
    expect(order.at(-1)).toBe('+studydesk.localDataEpoch');
    expect(order.indexOf('-studydesk-v1')).toBeLessThan(order.length - 1);
    // The tab that wiped is not stale itself.
    expect(isPageStale()).toBe(false);
  });
});
