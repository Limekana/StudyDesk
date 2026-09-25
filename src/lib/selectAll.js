// v1.16 (limecore#28, #73) — every row a query matches, not the first page.
//
// PostgREST caps a response at the project's max-rows setting (Supabase's
// default is 1000) and returns the truncated page WITHOUT an error. Every
// pull in this app was a single un-ranged `select('*')`, so past the cap it
// silently returned an arbitrary subset — there was no `order` either — and
// `reconcileUnsynced` then took the missing rows for local-only work and
// re-pushed them on every launch. `lesson_attendance` grows every school day
// and reaches the cap within about a school year of daily use.
//
// Three choices, each one against a specific way paging goes wrong:
//
//   KEYSET, NOT OFFSET. Pages are `order('id').gt('id', last)`. Offset paging
//   skips an EXISTING row whenever a row is inserted or deleted ahead of the
//   cursor mid-pull. Keyset can only miss a row created during the pull,
//   which the next pull then finds. Every pulled table has a uuid `id` PK.
//
//   STOP ON THE COUNT, NOT ON A SHORT PAGE. The obvious loop — "stop when a
//   page comes back shorter than asked" — truncates again if the server's cap
//   is ever set BELOW the page size: the first page is short, so the loop
//   ends at the cap, silently, which is the bug this file exists to fix.
//   Page one asks for `count: 'exact'` and the loop runs until it has that
//   many rows (or a page comes back empty). A short page with rows still
//   outstanding logs a warning, because it means the cap is smaller than
//   anyone assumed.
//
//   ALL OR NOTHING. An error on any page returns that error and no rows.
//   A partial result that looks complete is exactly what drives a wrong
//   re-push or a wrong prune; callers already throw on `error`.
//
// Returns `{ data, error }`, the shape of a supabase response, so a call site
// changes from `supabase.from(t).select('*')` to `selectAll(supabase, t)`
// and its error handling stays as it was.

export const PAGE_SIZE = 1000;

// A pull that needs this many pages is 1,000,000 rows for one user in one
// table. Not a real account — a server ignoring the keyset filter, which
// would otherwise loop forever returning the same page.
const MAX_PAGES = 1000;

let warnedShortPage = false;

/**
 * @param {object} client     the supabase client
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.columns='*']
 * @param {(q: any) => any} [opts.filter]  applied to every page, e.g.
 *   `(q) => q.eq('user_id', uid)`. RLS already scopes every pull in this app
 *   to the signed-in user, so StudyDesk passes none.
 * @param {number} [opts.pageSize=PAGE_SIZE]
 * @returns {Promise<{data: any[] | null, error: any}>}
 */
export async function selectAll(client, table, { columns = '*', filter = (q) => q, pageSize = PAGE_SIZE } = {}) {
  const rows = [];
  let total = null;
  let lastId = null;

  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) {
      // Same all-or-nothing rule: never hand back a truncated list as complete.
      return {
        data: null,
        error: new Error(`selectAll(${table}): gave up after ${MAX_PAGES} pages`),
      };
    }
    let q = client.from(table).select(columns, page === 0 ? { count: 'exact' } : undefined);
    q = filter(q).order('id', { ascending: true }).limit(pageSize);
    if (lastId !== null) q = q.gt('id', lastId);

    const { data, error, count } = await q;
    if (error) return { data: null, error };
    if (page === 0) total = typeof count === 'number' ? count : null;

    const batch = data || [];
    rows.push(...batch);
    if (batch.length === 0) break;

    const nextId = batch[batch.length - 1].id;
    if (lastId !== null && !(String(nextId) > String(lastId))) {
      return {
        data: null,
        error: new Error(`selectAll(${table}): the id cursor did not advance; refusing to loop`),
      };
    }
    lastId = nextId;

    if (total !== null) {
      if (rows.length >= total) break;
      if (batch.length < pageSize && !warnedShortPage) {
        warnedShortPage = true;
        console.warn(
          `selectAll(${table}): a page returned ${batch.length} of ${pageSize} rows with ` +
          `${total - rows.length} still to fetch — the API max-rows cap is below the page size. ` +
          'Paging continues, so nothing is lost, but the cap should be checked.',
        );
      }
    } else if (batch.length < pageSize) {
      // No count came back. The short-page rule is the best available signal.
      break;
    }
  }

  return { data: rows, error: null };
}

/** Test seam: the short-page warning fires once per session. */
export function resetSelectAllWarnings() {
  warnedShortPage = false;
}
