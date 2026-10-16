import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// v1.18.1 (StudyDesk#169) — web, two tabs on account A; account B signs in
// in tab 2. Tab 2 claims the data for B and wipes A's. Tab 1 then hears of
// B's sign-in, and claimForUser(B) there says "nothing to do": B already owns
// the data. Tab 1 kept A's data in memory, wrote it back, and queued A's
// unsynced rows under B. Each "tab" below is its own instance of the module
// (vi.resetModules), over one shared localStorage, as in a browser.

const sent = vi.hoisted(() => ({ rows: [] }));
vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table) => ({
      upsert(row) {
        sent.rows.push({ table, row });
        return Promise.resolve({ error: null });
      },
    }),
    auth: { getUser: async () => ({ data: { user: { id: 'user-b' } } }) },
  },
}));

function storage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

let local;
async function openTab() {
  vi.resetModules();
  return {
    owner: await import('./deviceOwner.js'),
    outbox: await import('./outbox.js'),
    store: await import('./localStore.js'),
    sync: await import('./sync.js'),
  };
}

beforeEach(() => {
  local = storage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('navigator', { onLine: false });
  sent.rows = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('stale tabs', () => {
  it('the #169 scenario: the tab that did not claim finds itself stale', async () => {
    local.setItem('studydesk.ownerUserId', 'user-a');
    const tab1 = await openTab();
    const tab2 = await openTab();

    expect(tab2.owner.claimForUser('user-b')).toBe(true);
    expect(tab2.owner.isPageStale()).toBe(false);

    // What tab 1 used to go on: no claim, so no wipe.
    expect(tab1.owner.isPageStale()).toBe(true);
    expect(tab1.owner.claimForUser('user-b')).toBe(false);
  });

  it('a sign-out (the wipe) in another tab makes this tab stale; its own wipe does not', async () => {
    const tab1 = await openTab();
    const tab2 = await openTab();
    tab2.owner.markLocalDataReplaced();
    expect(tab2.owner.isPageStale()).toBe(false);
    expect(tab1.owner.isPageStale()).toBe(true);
  });

  it('adopting guest data is not a wipe: other tabs stay current', async () => {
    const tab1 = await openTab();
    const tab2 = await openTab();
    expect(tab2.owner.claimForUser('user-a')).toBe(false);
    expect(tab1.owner.isPageStale()).toBe(false);
    // Nor is the owner signing in again.
    expect(tab2.owner.claimForUser('user-a')).toBe(false);
    expect(tab1.owner.isPageStale()).toBe(false);
  });

  it('a mark that cannot be written leaves the page usable', async () => {
    const tab = await openTab();
    local.setItem = () => { throw new Error('blocked'); };
    tab.owner.markLocalDataReplaced();
    expect(tab.owner.isPageStale()).toBe(false);
  });

  it('a stale tab writes nothing to storage and queues nothing', async () => {
    const tab1 = await openTab();
    const tab2 = await openTab();
    tab2.owner.markLocalDataReplaced();

    expect(tab1.store.writeJson('studydesk-v1', { courses: { c: {} } }, { critical: true }).ok).toBe(false);
    expect(local.getItem('studydesk-v1')).toBe(null);
    // Not a storage failure: no alarm.
    expect(tab1.store.storageFailure()).toBe(null);

    tab1.outbox.enqueue('upsert_assignment', { id: 'a1', courseId: 'c1', title: 'A' });
    expect(local.getItem('studydesk-outbox')).toBe(null);

    // While tab 2, which did the wipe, still can.
    tab2.outbox.enqueue('upsert_assignment', { id: 'b1', courseId: 'c2', title: 'B' });
    expect(JSON.parse(local.getItem('studydesk-outbox')).map((i) => i.payload.id)).toEqual(['b1']);
  });

  it('a stale tab sends nothing: no drain, and every sync call refuses', async () => {
    const tab1 = await openTab();
    const tab2 = await openTab();
    tab2.outbox.enqueue('upsert_assignment', { id: 'b1', courseId: 'c2', title: 'B' });
    tab2.owner.markLocalDataReplaced();
    vi.stubGlobal('navigator', { onLine: true });

    await tab1.outbox.drain();
    expect(sent.rows).toEqual([]);
    await expect(tab1.sync.upsertSubject({ id: 'c1', name: 'A' })).rejects.toThrow(/another tab/);
    expect(sent.rows).toEqual([]);

    await tab2.outbox.drain();
    expect(sent.rows.map((r) => r.row.id)).toEqual(['b1']);
  });
});

describe('watchPageStale', () => {
  function fakeWindow() {
    const listeners = new Set();
    return {
      addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'storage') listeners.delete(fn); },
      fire: (key) => { for (const fn of [...listeners]) fn({ key }); },
      count: () => listeners.size,
    };
  }

  it('fires once, on the epoch key or a full clear, and only when stale', async () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const tab1 = await openTab();
    const tab2 = await openTab();
    const onStale = vi.fn();
    const stop = tab1.owner.watchPageStale(onStale);

    win.fire('studydesk.localDataEpoch');
    expect(onStale).not.toHaveBeenCalled();

    tab2.owner.markLocalDataReplaced();
    win.fire('studydesk-v1');
    expect(onStale).not.toHaveBeenCalled();
    win.fire('studydesk.localDataEpoch');
    win.fire(null);
    expect(onStale).toHaveBeenCalledTimes(1);

    stop();
    expect(win.count()).toBe(0);
  });
});

describe('reloadStalePage', () => {
  it('reloads once and leaves a notice for the reloaded page, taken once', async () => {
    const session = storage();
    const reload = vi.fn();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('window', { location: { reload } });
    const tab = await openTab();

    tab.owner.reloadStalePage();
    tab.owner.reloadStalePage();
    expect(reload).toHaveBeenCalledTimes(1);

    const next = await openTab();
    expect(next.owner.takeStaleReloadNotice()).toBe(true);
    expect(next.owner.takeStaleReloadNotice()).toBe(false);
  });
});
