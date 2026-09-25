import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.16 (#67) — the F-Droid update check. The HTTP client, the app info and
// the platform are injected; storage is an in-memory stand-in.

function storage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}
vi.stubGlobal('localStorage', storage());

const mod = await import('./fdroidUpdate.js');
const { checkFdroidUpdate, setUpdateCheckEnabled, dismissUpdate, resetFdroidUpdateForTests } = mod;

const NOW = Date.parse('2026-09-25T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const RUNNING = { version: '1.10.1', build: '20' };

/** An F-Droid API stand-in that records every request. */
function fdroid(body, { status = 200, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    get: async (opts) => {
      calls.push(opts.url);
      if (fail) throw new Error('offline');
      return { status, data: body };
    },
  };
}
const answer = (code, name) => ({
  packageName: 'com.StudyDesk.app',
  suggestedVersionCode: code,
  packages: [{ versionName: name, versionCode: code }, { versionName: '1.10.1', versionCode: 20 }],
});
const app = (info = RUNNING) => ({ getInfo: async () => info });
const run = (http, over = {}) => checkFdroidUpdate({ now: NOW, http, app: app(), platform: 'android', ...over });

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  resetFdroidUpdateForTests();
});

describe('checkFdroidUpdate', () => {
  it('announces a newer F-Droid build, with both version names', async () => {
    const http = fdroid(answer(30, '1.15.1'));
    expect(await run(http)).toEqual({ current: { code: 20, name: '1.10.1' }, latest: { code: 30, name: '1.15.1' } });
    expect(http.calls).toEqual(['https://f-droid.org/api/v1/packages/com.StudyDesk.app']);
  });

  it('says nothing when this build is current or newer', async () => {
    expect(await run(fdroid(answer(20, '1.10.1')))).toBeNull();
    localStorage.clear();
    expect(await run(fdroid(answer(19, '1.10.0')))).toBeNull();
  });

  it('asks F-Droid at most once a day', async () => {
    const http = fdroid(answer(30, '1.15.1'));
    await run(http);
    expect(await run(http, { now: NOW + 23 * HOUR })).not.toBeNull(); // answered from cache
    expect(http.calls).toHaveLength(1);
    await run(http, { now: NOW + 25 * HOUR });
    expect(http.calls).toHaveLength(2);
  });

  it('a failed request is silent and still counts against the day', async () => {
    const down = fdroid(null, { fail: true });
    expect(await run(down)).toBeNull();
    const up = fdroid(answer(30, '1.15.1'));
    expect(await run(up, { now: NOW + HOUR })).toBeNull();
    expect(up.calls).toHaveLength(0);
  });

  it('is silent on an HTTP error or a malformed answer', async () => {
    expect(await run(fdroid(answer(30, 'x'), { status: 404 }))).toBeNull();
    localStorage.clear();
    expect(await run(fdroid({ suggestedVersionCode: 'soon' }))).toBeNull();
    localStorage.clear();
    expect(await run(fdroid('not json'))).toBeNull();
  });

  it('accepts the body as a JSON string, as the native client may return it', async () => {
    expect(await run(fdroid(JSON.stringify(answer(30, '1.15.1'))))).not.toBeNull();
  });

  it('never runs off Android', async () => {
    for (const platform of ['web', 'electron', 'ios']) {
      const http = fdroid(answer(30, '1.15.1'));
      expect(await run(http, { platform })).toBeNull();
      expect(http.calls).toHaveLength(0);
    }
  });
});

describe('the Settings switch', () => {
  it('off means no request at all, not just no notice', async () => {
    setUpdateCheckEnabled(false);
    const http = fdroid(answer(30, '1.15.1'));
    expect(await run(http)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('turning it off hides a notice already showing, and forgets the answer', async () => {
    await run(fdroid(answer(30, '1.15.1')));
    setUpdateCheckEnabled(false);
    expect(localStorage.getItem('sd-fdroid-last')).toBeNull();
    setUpdateCheckEnabled(true);
    const http = fdroid(answer(30, '1.15.1'));
    expect(await run(http)).not.toBeNull();
    expect(http.calls).toHaveLength(1); // a fresh request, not a stale cache
  });

  it('survives a restart: the off setting is stored', async () => {
    setUpdateCheckEnabled(false);
    resetFdroidUpdateForTests();
    const http = fdroid(answer(30, '1.15.1'));
    expect(await run(http)).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

describe('dismissal', () => {
  it('hides that version, and the next version is announced again', async () => {
    await run(fdroid(answer(30, '1.15.1')));
    dismissUpdate();
    expect(await run(fdroid(answer(30, '1.15.1')), { now: NOW + 25 * HOUR })).toBeNull();
    expect(await run(fdroid(answer(31, '1.16.0')), { now: NOW + 50 * HOUR })).toEqual({
      current: { code: 20, name: '1.10.1' },
      latest: { code: 31, name: '1.16.0' },
    });
  });
});
