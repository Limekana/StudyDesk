import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest.js';

// v1.16 (limecore#16) — what an error report contains, and when one is sent.
// A port of NCC's errorReports.test.ts; the privacy policy (NCC#50) describes
// exactly this, so these are its tests too.

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

const holder = vi.hoisted(() => ({ session: null, inserts: [], fail: false, client: null }));
vi.mock('./supabase.js', () => ({
  get supabase() {
    return {
      auth: { getSession: async () => ({ data: { session: holder.session } }) },
      from: (table) => {
        if (holder.client) return holder.client.from(table);
        return {
          insert: async (row) => {
            if (holder.fail) return { error: { message: 'network' } };
            holder.inserts.push({ table, row });
            return { error: null };
          },
        };
      },
    };
  },
}));

const mod = await import('./errorReports.js');
const { scrub, buildReport, osVersion, sendReport, setErrorReportsEnabled, setReportScreen, installGlobalErrorHandlers, resetErrorReportsForTests } = mod;
const { serverOnlyData } = await import('./dataRights.js');

const USER = { id: 'user-1' };

function thrown(message, name = 'TypeError') {
  const e = new Error(message);
  e.name = name;
  e.stack = `${name}: ${message}\n    at renderGrade (https://localhost/assets/index-abc123.js?v=9:1:204511)\n    at x (https://localhost/assets/vendor.js:2:10)`;
  return e;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  resetErrorReportsForTests();
  holder.session = { user: USER };
  holder.inserts = [];
  holder.fail = false;
  holder.client = null;
});

describe('what a report contains', () => {
  it('strips email addresses and runs of six or more digits from the message', () => {
    expect(scrub('no user anna.k@example.com with id 12345678 or year 2026', 500)).toBe(
      'no user [email] with id [number] or year 2026',
    );
  });

  it('cuts the message to 500 characters and the stack to 4,000', () => {
    expect(buildReport(thrown('x'.repeat(900))).message).toHaveLength(500);
    const long = thrown('m');
    long.stack = 'TypeError: m\n' + Array.from({ length: 400 }, (_, i) => `    at f${i} (https://localhost/a.js:1:${i})`).join('\n');
    expect(buildReport(long).stack.length).toBeLessThanOrEqual(4000);
  });

  it('keeps stack frames but never the stack\'s own copy of the message', () => {
    const r = buildReport(thrown('grade for anna.k@example.com'));
    expect(r.stack).not.toContain('anna');
    expect(r.stack).not.toContain('TypeError:');
    expect(r.stack).toContain('at renderGrade');
    expect(r.message).toBe('grade for [email]');
  });

  it('fingerprints by error name and first frame, so a repeat is deduplicated', () => {
    expect(buildReport(thrown('a')).fingerprint).toBe('TypeError@at renderGrade (https://localhost/assets/index-abc123.js:1:204511)');
    expect(buildReport(thrown('b')).fingerprint).toBe(buildReport(thrown('a')).fingerprint);
  });

  it('records the view App.jsx reported', () => {
    setReportScreen('grades');
    expect(buildReport(thrown('x')).screen).toBe('grades');
  });

  it('reduces the user agent to OS and engine versions', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; SM-S921B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.146 Mobile Safari/537.36';
    expect(osVersion(ua)).toBe('Android 14 · Chrome/128');
  });

  it('carries only the documented fields', () => {
    expect(Object.keys(buildReport(thrown('x'))).sort()).toEqual(
      ['app', 'app_version', 'error_name', 'fingerprint', 'message', 'os_version', 'platform', 'screen', 'stack'].sort(),
    );
    expect(buildReport(thrown('x')).app).toBe('studydesk');
  });
});

describe('when a report is sent', () => {
  it('sends nothing while the switch is off (the default)', async () => {
    expect(await sendReport(buildReport(thrown('x')))).toBe('off');
    expect(holder.inserts).toEqual([]);
  });

  it('the crash screen\'s one-time consent sends even with the switch off', async () => {
    expect(await sendReport(buildReport(thrown('x')), { consent: true })).toBe('sent');
    expect(holder.inserts[0].table).toBe('client_errors');
    expect('user_id' in holder.inserts[0].row).toBe(false);
  });

  it('a guest never sends, whatever the switch says', async () => {
    holder.session = null;
    setErrorReportsEnabled(true);
    expect(await sendReport(buildReport(thrown('x')))).toBe('guest');
    expect(await sendReport(buildReport(thrown('x')), { consent: true })).toBe('guest');
    expect(holder.inserts).toEqual([]);
  });

  it('the same error is sent once per session; a failure can be retried', async () => {
    setErrorReportsEnabled(true);
    holder.fail = true;
    expect(await sendReport(buildReport(thrown('a')))).toBe('failed');
    holder.fail = false;
    expect(await sendReport(buildReport(thrown('a')))).toBe('sent');
    expect(await sendReport(buildReport(thrown('b')))).toBe('duplicate');
    expect(holder.inserts).toHaveLength(1);
  });

  it('uncaught errors are reported only while the switch is on', async () => {
    const handlers = {};
    const w = {
      addEventListener: (t, h) => void (handlers[t] ??= []).push(h),
      removeEventListener: () => {},
    };
    installGlobalErrorHandlers(w);
    handlers.error.forEach((h) => h({ error: thrown('one') }));
    await new Promise((r) => setTimeout(r, 0));
    expect(holder.inserts).toEqual([]);
    setErrorReportsEnabled(true);
    handlers.unhandledrejection.forEach((h) => h({ reason: thrown('two', 'RangeError') }));
    await new Promise((r) => setTimeout(r, 0));
    expect(holder.inserts.map((i) => i.row.error_name)).toEqual(['RangeError']);
  });
});

describe('the export includes what exists only on the server', () => {
  it('reads the user\'s feedback and error reports, and nobody else\'s', async () => {
    holder.client = fakeClient({
      feedback: [{ id: 'f1', user_id: USER.id }, { id: 'f2', user_id: 'someone-else' }],
      client_errors: [{ id: 'e1', user_id: USER.id }],
    });
    const server = await serverOnlyData(USER.id);
    expect(server.feedback.map((r) => r.id)).toEqual(['f1']);
    expect(server.client_errors.map((r) => r.id)).toEqual(['e1']);
  });

  it('records a failed read instead of leaving the table out', async () => {
    holder.client = fakeClient({}, { failWhen: (req) => (req.table === 'feedback' ? { code: '57014', message: 'timeout' } : null) });
    expect((await serverOnlyData(USER.id)).feedback).toEqual({ error: 'timeout' });
  });
});
