import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// limecore#24 — the Realtime channel: what it binds, what the sync panel is
// told, and the recurrence guard (every bound table is published).

const holder = vi.hoisted(() => ({ channels: [] }));
vi.mock('./supabase.js', () => ({
  supabase: {
    channel(name) {
      const ch = {
        name,
        bindings: [],
        systemHandler: null,
        subscribeCb: null,
        on(type, opts, cb) {
          if (type === 'system') this.systemHandler = cb;
          else this.bindings.push(opts);
          return this;
        },
        subscribe(cb) { this.subscribeCb = cb; return this; },
      };
      holder.channels.push(ch);
      return ch;
    },
    removeChannel() {},
  },
}));

const sync = await import('./sync.js');

const migration = (file) => readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
/** The quoted table names inside the migration's `array[...]` literal. */
const tablesIn = (sql) => new Set([...sql.slice(sql.indexOf('array[')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

beforeEach(() => {
  sync.stopRealtime();
  holder.channels.length = 0;
});

describe('startRealtime', () => {
  it('binds every table, scoped to the user', () => {
    sync.startRealtime(() => {}, 'u-1');
    const ch = holder.channels[0];
    expect(ch.bindings.map((b) => b.table)).toEqual(sync.REALTIME_TABLES);
    for (const b of ch.bindings) expect(b.filter).toBe('user_id=eq.u-1');
  });

  it('binds without a filter when no user id is given', () => {
    sync.startRealtime(() => {});
    expect(holder.channels[0].bindings.every((b) => !('filter' in b))).toBe(true);
  });

  it('reports connecting, then live, then down when the server rejects the bindings', () => {
    const seen = [];
    const unsub = sync.subscribeRealtimeState(() => seen.push(sync.getRealtimeState()));
    sync.startRealtime(() => {}, 'u-1');
    const ch = holder.channels[0];
    expect(sync.getRealtimeState()).toBe('connecting');
    ch.subscribeCb('SUBSCRIBED');
    expect(sync.getRealtimeState()).toBe('live');
    // The production failure: the join succeeds, then a system error arrives.
    ch.systemHandler({ status: 'error', message: 'Unable to subscribe to changes with given parameters.' });
    expect(sync.getRealtimeState()).toBe('down');
    unsub();
    expect(seen).toEqual(['connecting', 'live', 'down']);
  });

  it('a dropped channel is down until it rejoins', () => {
    sync.startRealtime(() => {}, 'u-1');
    const ch = holder.channels[0];
    ch.subscribeCb('CHANNEL_ERROR', new Error('socket closed'));
    expect(sync.getRealtimeState()).toBe('down');
    ch.subscribeCb('SUBSCRIBED');
    expect(sync.getRealtimeState()).toBe('live');
  });

  it('stopping is off, and the CLOSED that follows does not flip it to down', () => {
    sync.startRealtime(() => {}, 'u-1');
    const ch = holder.channels[0];
    ch.subscribeCb('SUBSCRIBED');
    sync.stopRealtime();
    ch.subscribeCb('CLOSED');
    expect(sync.getRealtimeState()).toBe('off');
  });
});

describe('recurrence guard (limecore#24)', () => {
  // The server rejects the WHOLE channel for one unpublished table, which is
  // how live sync stayed dead from v1.7 to v1.17. Binding a new table means
  // adding it to both migrations below, or writing a new one that does.
  it('every bound table is in the publication migration', () => {
    const published = tablesIn(migration('20261006_realtime_publish.sql'));
    expect(sync.REALTIME_TABLES.filter((t) => !published.has(t))).toEqual([]);
  });

  it('every bound table has the echo guard', () => {
    const guarded = tablesIn(migration('20261006_realtime_echo_guard.sql'));
    expect(sync.REALTIME_TABLES.filter((t) => !guarded.has(t))).toEqual([]);
  });
});
