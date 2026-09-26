-- limecore#27 (P0-A), step 1 of 2 — the server half of the owner's decision,
-- 2026-09-25: "Option 1, delete wins".
--
-- Rewrites `public.set_updated_at()`, the BEFORE INSERT OR UPDATE guard already
-- attached to 15 tables (grades, subjects, study_sessions, tasks, transactions,
-- budget_categories, goals, manual_assets, portfolio_holdings, portfolio_lots,
-- profiles, readings, watchlist_items, work_quality_logs, workout_sessions).
-- It already rejected an update older than the stored row (last-writer-wins on
-- the client's `updated_at`). Three changes:
--
-- 1. CLAMP. The stamp was trusted unclamped, so one phone with its clock set
--    ahead could write a future stamp and silently lock every other device out
--    of that row until real time caught up. A stamp from the future is now
--    lowered to the server's `now()`. For the comparison, a row ALREADY stamped
--    in the future is treated as `now()` too, which heals one if it exists.
--    (Measured 2026-09-25: 0 such rows across ~3,000 in ten tables.)
--
-- 2. DELETE WINS — a delete is never lost to a race. A tombstone
--    (`deleted_at` going from NULL to a value) always lands, whatever its
--    stamp, and is stamped at least as new as the row it replaces, so every
--    client's own last-writer-wins merge converges on it. This is the core of
--    the decision: a delete made offline at 10:00 beats an edit made elsewhere
--    at 11:00 that it raced with. Under plain LWW the delete lost.
--
-- 3. REVIVAL STAYS LAST-WRITER-WINS. "Delete wins" does NOT mean deletes are
--    permanent. StudyDesk revives an attendance row by design: clearing a mark
--    tombstones it, and re-marking the same lesson upserts `deleted_at: null`
--    onto it (src/lib/sync.js `upsertAttendance`). Every shipped version does
--    this, so blocking revivals would silently break re-marking attendance for
--    all of them (P1). An explicit revival is therefore accepted when it is
--    newer than the tombstone, like any other update. A content edit that does
--    not mention `deleted_at` — every snapshot upsert in StudyDesk and NCC —
--    leaves the column alone and so can never un-delete anything.
--
-- `deleted_at` is read through `to_jsonb(...)`, not `NEW.deleted_at`, because
-- three of the guarded tables (portfolio_holdings, profiles, work_quality_logs)
-- have no such column and a direct reference would throw on every update.
--
-- P1 / old app versions: no shipped client gets an error from this. A write
-- the guard declines is a silent no-op (`RETURN OLD`), exactly as today. Old
-- StudyDesk and LimeLog builds stamp PUSH time rather than edit time, so their
-- late pushes still win conflicts they should lose — no server change can tell
-- a late push of an old edit from a fresh edit — but they lose nothing they
-- keep today, and their deletes now always land.
--
-- Safe to apply on its own, before any client ships: for every existing row
-- and every current client it only lowers a future stamp or lets a tombstone
-- through. Step 2 (20260925_lww_guard_regime_c.sql) extends the guard to the
-- 12 tables that have none, and should be applied with the client release.
--
-- Tested against Postgres 17 before review: supabase/tests/lww_guard.test.sql.
-- APPLIED to production 2026-09-25 (owner-confirmed) as `v116_lww_clamp_delete_wins`, version 20260925190821.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  old_deleted text;
  new_deleted text;
begin
  -- 1. Clamp. NULL means "the client did not say": stamp it now, as before.
  if new.updated_at is null or new.updated_at > now() then
    new.updated_at := now();
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  old_deleted := to_jsonb(old) ->> 'deleted_at';
  new_deleted := to_jsonb(new) ->> 'deleted_at';

  -- 2. Delete wins: a tombstone always lands, and is at least as new as the
  --    row it replaces.
  if old_deleted is null and new_deleted is not null then
    new.updated_at := greatest(new.updated_at, least(old.updated_at, now()));
    return new;
  end if;

  -- 3. Everything else, a revival included, is last-writer-wins. A stored
  --    stamp from the future counts as now, so it cannot lock the row.
  if old.updated_at is not null and new.updated_at < least(old.updated_at, now()) then
    return old;
  end if;

  return new;
end;
$function$;
