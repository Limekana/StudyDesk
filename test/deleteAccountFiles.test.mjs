import { describe, it, expect } from 'vitest';
import { removeUserFiles, rateLimitBuckets, eraseAccount } from '../supabase/functions/delete-account/userFiles.js';

// v1.18.1 (limecore#61) — account deletion left the user's Storage files
// behind: the cascade from auth.users does not reach storage.objects. A
// stand-in for the service-role client: listBuckets(), list() one level per
// call with folders as entries with no id, paged by `limit` from `offset`,
// remove() by path, and the auth and table calls eraseAccount makes.

function fakeAdmin(files, { buckets = ['avatars', 'assignment-attachments', 'notebook'] } = {}) {
  const store = Object.fromEntries(buckets.map((b) => [b, new Set(files[b] ?? [])]));
  const calls = [];
  const admin = {
    store,
    calls,
    storage: {
      async listBuckets() {
        return { data: buckets.map((id) => ({ id, name: id })), error: null };
      },
      from(bucket) {
        return {
          async list(prefix, { limit, offset = 0 }) {
            calls.push(['list', bucket, prefix, offset]);
            const below = [...store[bucket]].filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length + 1));
            const names = [...new Set(below.map((rest) => rest.split('/')[0]))].sort();
            const entries = names.map((name) => ({ name, id: below.includes(name) ? `obj-${name}` : null }));
            return { data: entries.slice(offset, offset + limit), error: null };
          },
          async remove(paths) {
            calls.push(['remove', bucket, paths.length]);
            for (const p of paths) store[bucket].delete(p);
            return { data: [], error: null };
          },
        };
      },
    },
    auth: { admin: { async deleteUser(id) { calls.push(['deleteUser', id]); return { error: null }; } } },
    from(table) {
      return { delete: () => ({ in: async (col, vals) => { calls.push(['delete', table, col, vals]); return { error: null }; } }) };
    },
  };
  return admin;
}

const quiet = { error() {} };

describe('removeUserFiles (limecore#61)', () => {
  it('removes the user\'s files in every bucket the project has, nested folders included, and only that user\'s', async () => {
    const admin = fakeAdmin({
      avatars: ['u1/avatar.jpg', 'u2/avatar.jpg'],
      'assignment-attachments': ['u1/a1/essay.pdf', 'u1/a2/notes.png', 'u1/a2/draft.docx', 'u2/a9/x.pdf'],
      notebook: ['u1/n1/sketch.png'],
    });
    const removed = await removeUserFiles(admin, 'u1');
    expect(removed).toEqual({ avatars: 1, 'assignment-attachments': 3, notebook: 1 });
    expect([...admin.store.avatars]).toEqual(['u2/avatar.jpg']);
    expect([...admin.store['assignment-attachments']]).toEqual(['u2/a9/x.pdf']);
    expect([...admin.store.notebook]).toEqual([]);
  });

  it('covers a bucket added later without a code change', async () => {
    const admin = fakeAdmin({ exports: ['u1/2026.zip'] }, { buckets: ['avatars', 'exports'] });
    expect(await removeUserFiles(admin, 'u1')).toEqual({ avatars: 0, exports: 1 });
  });

  it('pages through more than 1000 files, and removes them in batches of 100', async () => {
    const many = Array.from({ length: 2345 }, (_, i) => `u1/a/f${String(i).padStart(4, '0')}.pdf`);
    const admin = fakeAdmin({ 'assignment-attachments': many });
    expect((await removeUserFiles(admin, 'u1'))['assignment-attachments']).toBe(2345);
    expect(admin.store['assignment-attachments'].size).toBe(0);
    const batches = admin.calls.filter((c) => c[0] === 'remove' && c[1] === 'assignment-attachments').map((c) => c[2]);
    expect(batches).toHaveLength(24);
    expect(Math.max(...batches)).toBe(100);
  });

  it('throws if anything is still in the user\'s folder afterwards', async () => {
    const admin = fakeAdmin({ avatars: ['u1/avatar.jpg'] });
    const from = admin.storage.from;
    admin.storage.from = (b) => ({ ...from(b), remove: async () => ({ data: [], error: null }) }); // removes nothing
    await expect(removeUserFiles(admin, 'u1')).rejects.toThrow('files remain in avatars');
  });
});

describe('eraseAccount (limecore#61)', () => {
  it('removes the files, then the user, then the rate-limit rows', async () => {
    const admin = fakeAdmin({ avatars: ['u1/avatar.jpg'] });
    expect(await eraseAccount(admin, 'u1', quiet)).toEqual({ ok: true, filesLeft: false });
    const order = admin.calls.filter((c) => c[0] !== 'list').map((c) => c[0] + (c[1] && c[0] !== 'deleteUser' ? `:${c[1]}` : ''));
    expect(order).toEqual(['remove:avatars', 'deleteUser', 'delete:ai_rate_limits']);
    expect(admin.calls.at(-1)).toEqual(['delete', 'ai_rate_limits', 'bucket', ['user:u1', 'user:u1:day']]);
  });

  it('a storage fault is logged for the owner and does not block the erasure', async () => {
    const admin = fakeAdmin({ avatars: ['u1/avatar.jpg'] });
    admin.storage.listBuckets = async () => ({ data: null, error: new Error('storage down') });
    const logged = [];
    const result = await eraseAccount(admin, 'u1', { error: (...a) => logged.push(a) });
    expect(result).toEqual({ ok: true, filesLeft: true });
    expect(admin.calls.some((c) => c[0] === 'deleteUser')).toBe(true);
    expect(logged[0][0]).toMatch(/files left/);
    expect(logged[0][1]).toMatchObject({ userId: 'u1', message: 'storage down' });
  });

  it('reports a failed account deletion', async () => {
    const admin = fakeAdmin({});
    admin.auth.admin.deleteUser = async () => ({ error: { message: 'nope' } });
    expect(await eraseAccount(admin, 'u1', quiet)).toEqual({ ok: false, filesLeft: false });
  });
});

describe('rateLimitBuckets', () => {
  it('names both of the user\'s windows', () => {
    expect(rateLimitBuckets('u1')).toEqual(['user:u1', 'user:u1:day']);
  });
});
