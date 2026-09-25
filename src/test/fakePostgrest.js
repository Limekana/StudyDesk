// A small stand-in for supabase-js's query builder, faithful to the parts of
// PostgREST that paging depends on:
//   - a response is capped at `maxRows` whatever `limit` asked for, and the
//     truncated page comes back WITHOUT an error — the behaviour that made
//     every un-ranged pull in this app silently lossy;
//   - `count: 'exact'` reports the full filtered total, not the page size;
//   - uuids order the way Postgres orders them.
// Not a test file itself (no `.test.`), so Vitest does not collect it, and
// nothing in the app imports it, so it never reaches a bundle.

export function makeUuids(n) {
  return Array.from({ length: n }, () => crypto.randomUUID());
}

/**
 * @param {Record<string, object[]>} tables  rows per table, in any order
 * @param {object} [opts]
 * @param {number} [opts.maxRows=1000]   the API max-rows cap
 * @param {boolean} [opts.withCount=true] whether `count: 'exact'` is honoured
 * @param {boolean} [opts.ignoreGt=false] a broken server that drops the keyset filter
 * @param {(req: object) => any} [opts.failWhen] return an error object to fail that request
 */
export function fakeClient(tables, { maxRows = 1000, withCount = true, ignoreGt = false, failWhen } = {}) {
  const requests = [];

  function from(table) {
    const req = { table, filters: [], order: null, limit: null, gt: null, count: null };
    const builder = {
      select(columns, opts) {
        req.columns = columns;
        req.count = opts && opts.count ? opts.count : null;
        return builder;
      },
      eq(col, val) { req.filters.push([col, val]); return builder; },
      order(col, o) { req.order = { col, ascending: !o || o.ascending !== false }; return builder; },
      limit(n) { req.limit = n; return builder; },
      gt(col, val) { req.gt = [col, val]; return builder; },
      then(resolve, reject) {
        return Promise.resolve().then(() => execute(req)).then(resolve, reject);
      },
    };
    return builder;
  }

  function execute(req) {
    requests.push(req);
    const failure = failWhen && failWhen(req, requests.length);
    if (failure) return { data: null, error: failure, count: null };
    if (!(req.table in tables)) {
      return { data: null, error: { code: '42P01', message: `relation "${req.table}" does not exist` }, count: null };
    }

    let rows = tables[req.table].filter((r) => req.filters.every(([c, v]) => r[c] === v));
    const total = rows.length;
    if (req.gt && !ignoreGt) rows = rows.filter((r) => String(r[req.gt[0]]) > String(req.gt[1]));
    if (req.order) {
      const { col, ascending } = req.order;
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    const take = Math.min(req.limit == null ? Infinity : req.limit, maxRows);
    return {
      data: rows.slice(0, take),
      error: null,
      count: req.count && withCount ? total : null,
    };
  }

  return { from, requests };
}
