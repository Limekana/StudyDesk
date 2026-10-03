import { describe, it, expect, beforeEach, vi } from 'vitest';
import { selectAll, PAGE_SIZE, resetSelectAllWarnings } from './selectAll.js';
import { fakeClient, makeUuids } from '../test/fakePostgrest.js';

// v1.16 (limecore#28, StudyDesk#73). PostgREST truncates past its max-rows
// cap without an error; these pin that `selectAll` returns every row anyway,
// including in the case the obvious "stop on a short page" loop gets wrong.

function rowsOf(n, extra = {}) {
  return makeUuids(n).map((id, i) => ({ id, n: i, ...extra }));
}

const idsOf = (rows) => rows.map((r) => r.id).sort();

beforeEach(() => {
  resetSelectAllWarnings();
  vi.restoreAllMocks();
});

describe('selectAll', () => {
  it('returns a small table in one request', async () => {
    const all = rowsOf(115);
    const client = fakeClient({ assignments: all });
    const { data, error } = await selectAll(client, 'assignments');
    expect(error).toBeNull();
    expect(idsOf(data)).toEqual(idsOf(all));
    expect(client.requests).toHaveLength(1);
  });

  it('returns every row past the cap — the case a bare select() truncates', async () => {
    const all = rowsOf(2500);
    const client = fakeClient({ lesson_attendance: all });

    // The regression, reproduced: what the old one-shot pull saw.
    const bare = await client.from('lesson_attendance').select('*');
    expect(bare.error).toBeNull();
    expect(bare.data).toHaveLength(1000);

    const { data, error } = await selectAll(client, 'lesson_attendance');
    expect(error).toBeNull();
    expect(data).toHaveLength(2500);
    expect(idsOf(data)).toEqual(idsOf(all));
    expect(new Set(data.map((r) => r.id)).size).toBe(2500);
  });

  it('pages in id order with a keyset cursor, not an offset', async () => {
    const client = fakeClient({ t: rowsOf(2500) });
    await selectAll(client, 't');
    const [first, second, third] = client.requests;
    expect(first.order).toEqual({ col: 'id', ascending: true });
    expect(first.gt).toBeNull();
    // Each later page starts strictly after the last id already held.
    expect(second.gt[0]).toBe('id');
    expect(third.gt[1] > second.gt[1]).toBe(true);
  });

  it('asks for the exact count on the first page only', async () => {
    const client = fakeClient({ t: rowsOf(2500) });
    await selectAll(client, 't');
    expect(client.requests.map((r) => r.count)).toEqual(['exact', null, null]);
  });

  it('keeps paging when the server cap is BELOW the page size, and warns', async () => {
    // The hole in "stop when a page comes back short": with a 500-row cap the
    // first page IS short, and that loop would stop at 500 — silently.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const all = rowsOf(1700);
    const client = fakeClient({ t: all }, { maxRows: 500 });
    const { data, error } = await selectAll(client, 't');
    expect(error).toBeNull();
    expect(idsOf(data)).toEqual(idsOf(all));
    expect(client.requests).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/max-rows cap is below the page size/);
  });

  it('stops after exactly one request when the table holds exactly one page', async () => {
    // The count says it is done; no trailing empty request.
    const client = fakeClient({ t: rowsOf(PAGE_SIZE) });
    const { data } = await selectAll(client, 't');
    expect(data).toHaveLength(PAGE_SIZE);
    expect(client.requests).toHaveLength(1);
  });

  it('returns an empty list for an empty table', async () => {
    const client = fakeClient({ t: [] });
    const { data, error } = await selectAll(client, 't');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('applies the filter to every page, not just the first', async () => {
    const mine = rowsOf(1500, { user_id: 'me' });
    const theirs = rowsOf(800, { user_id: 'them' });
    const client = fakeClient({ t: [...mine, ...theirs] });
    const { data } = await selectAll(client, 't', { filter: (q) => q.eq('user_id', 'me') });
    expect(idsOf(data)).toEqual(idsOf(mine));
    expect(client.requests.every((r) => r.filters.some(([c, v]) => c === 'user_id' && v === 'me'))).toBe(true);
  });

  it('returns the error and NO rows when a later page fails', async () => {
    // All or nothing. A partial list that looks complete is what makes the
    // app re-push rows it thinks are missing, or prune rows it thinks were
    // deleted.
    const client = fakeClient({ t: rowsOf(2500) }, {
      failWhen: (_req, n) => (n === 2 ? { code: '57014', message: 'canceling statement due to statement timeout' } : null),
    });
    const { data, error } = await selectAll(client, 't');
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: '57014' });
  });

  it('passes a missing-table error through untouched, so callers can tolerate it', async () => {
    const client = fakeClient({});
    const { data, error } = await selectAll(client, 'notebook_entries');
    expect(data).toBeNull();
    expect(error.code).toBe('42P01');
  });

  it('falls back to the short-page rule when no count comes back', async () => {
    const all = rowsOf(2500);
    const client = fakeClient({ t: all }, { withCount: false });
    const { data } = await selectAll(client, 't');
    expect(idsOf(data)).toEqual(idsOf(all));
  });

  it('refuses to loop forever against a server that ignores the cursor', async () => {
    const client = fakeClient({ t: rowsOf(2500) }, { ignoreGt: true });
    const { data, error } = await selectAll(client, 't');
    expect(data).toBeNull();
    expect(error.message).toMatch(/cursor did not advance/);
    expect(client.requests.length).toBeLessThanOrEqual(2);
  });

  it('passes the column list through', async () => {
    const client = fakeClient({ t: rowsOf(3) });
    await selectAll(client, 't', { columns: 'id,updated_at' });
    expect(client.requests[0].columns).toBe('id,updated_at');
  });
});
