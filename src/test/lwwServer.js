// A stand-in for the parts of PostgREST + public.set_updated_at() that
// StudyDesk's sync relies on (supabase/migrations/20260925_lww_clamp_delete_wins.sql):
//   - a future or missing updated_at is clamped to now;
//   - a tombstone (deleted_at going from null to set) always lands;
//   - otherwise an update older than the stored row is declined (the row is
//     left as it was, and the request still succeeds, as in Postgres).
// And zz_skip_noop_update (20261006_realtime_echo_guard.sql): an UPDATE that
// changes nothing but updated_at writes no row. That covers a declined update
// too, which set_updated_at() turns back into the stored row. Either way the
// row is not affected, so an `.update().select()` returns no rows for it, as
// in production (v1.18.1, StudyDesk#145).
// And, on `subjects` only, subjects_archive_edit_stamp
// (20261016_archive_edit_stamp.sql), which runs before set_updated_at()
// (v1.18.1, StudyDesk#163): the archive is last-writer-wins on its own
// `archived_edited_at`; a write that does not send one (every shipped build)
// stamps an archive change with its own `updated_at` (an insert of an
// archived row too); an archive-only write
// that wins moves `updated_at` by 1 ms; a tombstone passes through untouched.
// Upsert honours `onConflict` and `ignoreDuplicates`; update and delete take
// chained `.eq()` filters and `.select()` returns the affected rows.
// `clockAheadMs` puts the server's clock ahead of this device's.
// `archiveColumn: false` is the server before 20261016_archive_edit_stamp.sql
// (no archive guard; refusing the column itself is left to the test). Not a test
// file itself.
export function makeLwwServer(initial = {}, { clockAheadMs = 0, archiveColumn = true } = {}) {
  const tables = {};
  for (const [k, rows] of Object.entries(initial)) tables[k] = rows.map((r) => ({ ...r }));
  let seq = 0;
  const genId = () => `srv-${++seq}`;
  const t = (iso) => (iso ? new Date(iso).getTime() : null);
  const log = [];

  function guard(oldRow, newRow) {
    const now = Date.now() + clockAheadMs;
    if (newRow.updated_at == null || t(newRow.updated_at) > now) newRow.updated_at = new Date(now).toISOString();
    if (!oldRow) return newRow;
    if (oldRow.deleted_at == null && newRow.deleted_at != null) {
      const floor = Math.min(t(oldRow.updated_at), now);
      if (t(newRow.updated_at) < floor) newRow.updated_at = new Date(floor).toISOString();
      return newRow;
    }
    if (oldRow.updated_at != null && t(newRow.updated_at) < Math.min(t(oldRow.updated_at), now)) return oldRow;
    return newRow;
  }

  const iso = (ms) => new Date(ms).toISOString();
  // Leaves a row that never had the column without it, as the seeded rows are.
  const setStamp = (row, v) => { if ((row.archived_edited_at ?? null) !== v) row.archived_edited_at = v; };
  const sameExcept = (a, b, skip) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of skip) keys.delete(k);
    return [...keys].every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
  };

  function archiveGuard(oldRow, newRow) {
    const now = Date.now() + clockAheadMs;
    if (newRow.archived_edited_at != null && t(newRow.archived_edited_at) > now) newRow.archived_edited_at = iso(now);
    if (!oldRow) {
      if (newRow.archived_at != null && newRow.archived_edited_at == null) {
        newRow.archived_edited_at = iso(Math.min(newRow.updated_at == null ? now : t(newRow.updated_at), now));
      }
      return newRow;
    }
    if (oldRow.deleted_at == null && newRow.deleted_at != null) return newRow;
    const stored = oldRow.archived_edited_at ?? null;
    const stamped = newRow.archived_edited_at != null && t(newRow.archived_edited_at) !== t(stored);
    let incoming;
    if (stamped) {
      incoming = t(newRow.archived_edited_at);
    } else {
      setStamp(newRow, stored);
      if (t(newRow.archived_at) === t(oldRow.archived_at)) return newRow;
      incoming = Math.min(newRow.updated_at == null ? now : t(newRow.updated_at), now);
    }
    if (stored != null && incoming < t(stored)) {
      newRow.archived_at = oldRow.archived_at ?? null;
      setStamp(newRow, stored);
      return newRow;
    }
    if (!stamped) setStamp(newRow, iso(incoming));
    if (stamped && sameExcept(newRow, oldRow, ['archived_at', 'archived_edited_at', 'updated_at'])) {
      newRow.updated_at = oldRow.updated_at == null ? null : iso(t(oldRow.updated_at) + 1);
    }
    return newRow;
  }

  // zz_skip_noop_update: compares every column but updated_at. By JSON value,
  // so jsonb columns compare by content; timestamps compare as written.
  const sameBut = (a, b) => sameExcept(a, b, ['updated_at']);

  /** The BEFORE triggers of `table`, in name order. */
  const triggersOf = (table) => (archiveColumn && table === 'subjects' ? (o, n) => guard(o, archiveGuard(o, n)) : guard);

  /** The row an UPDATE leaves, or null when no row is written. */
  function applyUpdate(table, oldRow, patch) {
    const next = triggersOf(table)(oldRow, { ...oldRow, ...patch });
    if (next === oldRow || sameBut(next, oldRow)) return null;
    return next;
  }

  function from(table) {
    const rows = tables[table] || (tables[table] = []);
    const filtered = (op, patch) => {
      const filters = [];
      let returning = false;
      const b = {
        eq(col, val) { filters.push([col, val]); return b; },
        select() { returning = true; return b; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            const hit = [];
            for (let i = 0; i < rows.length; i++) {
              if (!filters.every(([c, v]) => rows[i][c] === v)) continue;
              if (op === 'update') {
                const next = applyUpdate(table, rows[i], patch);
                if (!next) continue;
                rows[i] = next;
              }
              hit.push(rows[i]);
            }
            if (op === 'delete') tables[table] = rows.filter((r) => !hit.includes(r));
            log.push([op, table, Object.fromEntries(filters), patch ?? null, hit.length]);
            return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
          }).then(resolve, reject);
        },
      };
      return b;
    };
    return {
      upsert(payload, opts = {}) {
        const keys = opts.onConflict ? opts.onConflict.split(',') : ['id'];
        const i = rows.findIndex((r) => keys.every((k) => r[k] === payload[k]));
        if (i < 0) {
          rows.push(triggersOf(table)(null, { id: payload.id ?? genId(), deleted_at: null, ...payload }));
          log.push(['insert', table, payload]);
        } else if (opts.ignoreDuplicates) {
          // ON CONFLICT DO NOTHING.
          log.push(['upsert-ignored', table, payload]);
        } else {
          const next = applyUpdate(table, rows[i], payload);
          log.push([next ? 'upsert' : 'upsert-no-row', table, payload]);
          if (next) rows[i] = next;
        }
        return Promise.resolve({ error: null });
      },
      update: (patch) => filtered('update', patch),
      delete: () => filtered('delete'),
    };
  }
  return { tables, from, log };
}
