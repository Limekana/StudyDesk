import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// v1.18.1 (StudyDesk#144) — a device whose clock ran ahead stamped its edits
// in the future, kept those stamps, and so ignored newer edits from other
// devices on every pull. Stamps are now made in server time, using the offset
// measured from the server's Date header.

function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
vi.stubGlobal('localStorage', storage());
const { noteServerDate, fetchNotingServerTime, stampNow, serverNow, resetServerClock } = await import('./serverClock.js');
const { applyRemotePull } = await import('./merge.js');

const KEY = 'studydesk-server-clock-offset';
const base = { courses: {}, grades: [], studySessions: [] };
const pull = (notes) => ({ subjects: [], grades: [], sessions: [], notes });
const at = (iso) => vi.setSystemTime(new Date(iso));
// A response that took `roundTrip` ms and has just arrived.
const sample = (header, roundTrip = 0) => noteServerDate(header, Date.now() - roundTrip, Date.now());
const offset = () => serverNow() - Date.now();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetServerClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', storage());
});

describe('server clock (StudyDesk#144)', () => {
  it('a device 10 minutes fast stamps in server time and takes a newer edit from another device', () => {
    // Device clock 10:10, server says 10:00.
    at('2026-10-12T10:10:00Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT');
    // A edits now: the stamp is 10:00 (server time), not 10:10.
    const stamp = stampNow();
    expect(stamp).toBe('2026-10-12T10:00:00.000Z');
    const localA = [{ id: 'n1', content: 'A v1', updatedAt: stamp, deletedAt: null }];
    // B (correct clock) edits at 10:02; A pulls at 10:05.
    const server = [{ id: 'n1', content: 'A v1 + B line', updated_at: '2026-10-12T10:02:00+00:00', deleted_at: null }];
    const merged = applyRemotePull({ ...base, notes: localA }, pull(server));
    expect(merged.notes[0].content).toBe('A v1 + B line');
  });

  it('ignores differences of a few seconds (latency and whole-second headers)', () => {
    at('2026-10-12T10:00:03Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT');
    expect(serverNow()).toBe(Date.parse('2026-10-12T10:00:03Z'));
  });

  it('compares the header with the midpoint of the round trip', () => {
    // Sent at 10:10:00.000, answered at 10:10:01.000, header 10:00:00.
    at('2026-10-12T10:10:01Z');
    noteServerDate('Mon, 12 Oct 2026 10:00:00 GMT', Date.parse('2026-10-12T10:10:00Z'));
    expect(offset()).toBe(-600500);
  });

  it('discards a sample whose round trip took over 2 s', () => {
    at('2026-10-12T10:10:00Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT', 2500);
    expect(offset()).toBe(0);
    expect(localStorage.getItem(KEY)).toBeNull();
    // A clock that went backwards mid-request is no better.
    noteServerDate('Mon, 12 Oct 2026 10:00:00 GMT', Date.now() + 100, Date.now());
    expect(offset()).toBe(0);
  });

  it('applies from 5 s and keeps applying until below 2 s, so it does not flap', () => {
    at('2026-10-12T10:00:04Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT'); // 4 s: not yet
    expect(offset()).toBe(0);
    at('2026-10-12T10:00:06Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT'); // 6 s: applied
    expect(offset()).toBe(-6000);
    at('2026-10-12T10:00:03Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT'); // 3 s: kept, at the new value
    expect(offset()).toBe(-3000);
    at('2026-10-12T10:00:01Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT'); // 1 s: dropped
    expect(offset()).toBe(0);
  });

  it('keeps the offset with when it was measured, and ignores a missing or unreadable header', () => {
    at('2026-10-12T10:10:00Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT');
    expect(JSON.parse(localStorage.getItem(KEY))).toEqual({ offset: -600000, measuredAt: Date.parse('2026-10-12T10:10:00Z') });
    sample(undefined);
    sample('not a date');
    expect(serverNow()).toBe(Date.parse('2026-10-12T10:00:00Z'));
  });

  it('a fresh launch starts from the stored offset', async () => {
    at('2026-10-12T10:10:00Z');
    sample('Mon, 12 Oct 2026 10:00:00 GMT');
    at('2026-10-12T18:00:00Z');
    vi.resetModules();
    const fresh = await import('./serverClock.js');
    expect(fresh.stampNow()).toBe('2026-10-12T17:50:00.000Z');
  });

  it('a fresh launch ignores an offset measured more than a day ago', async () => {
    localStorage.setItem(KEY, JSON.stringify({ offset: -600000, measuredAt: Date.parse('2026-10-10T10:10:00Z') }));
    at('2026-10-12T10:10:00Z');
    vi.resetModules();
    const fresh = await import('./serverClock.js');
    expect(fresh.serverNow()).toBe(Date.now());
  });
});

describe('the fetch wrapper given to the Supabase client', () => {
  it('passes input and init through and returns the response unchanged', async () => {
    at('2026-10-12T10:10:00Z');
    const res = { status: 200, headers: new Headers({ date: 'Mon, 12 Oct 2026 10:00:00 GMT' }) };
    const fetchMock = vi.fn(async () => res);
    vi.stubGlobal('fetch', fetchMock);
    const init = { method: 'POST', body: '{}' };
    await expect(fetchNotingServerTime('https://x.test/rest/v1/notes', init)).resolves.toBe(res);
    expect(fetchMock).toHaveBeenCalledWith('https://x.test/rest/v1/notes', init);
    expect(offset()).toBe(-600000);
  });

  it('a response without a readable Date header changes nothing, and a failed request fails as it was', async () => {
    const res = { status: 200, headers: new Headers() };
    vi.stubGlobal('fetch', vi.fn(async () => res));
    await expect(fetchNotingServerTime('u')).resolves.toBe(res);
    expect(offset()).toBe(0);
    const err = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw err; }));
    await expect(fetchNotingServerTime('u')).rejects.toBe(err);
  });
});
