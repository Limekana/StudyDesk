-- v1.18.1 (limecore#63 §4) — the three SECURITY DEFINER functions that put
-- `public` before `pg_catalog` look up names in pg_catalog first.
--
-- `purge_soft_deleted(interval)`, `soft_deleted_pending(interval)` and
-- `erase_audit_log_for_user()` run as their owner, with
-- `search_path = public, pg_catalog` (checked 2026-10-15; the other definer
-- functions leave pg_catalog unlisted, and Postgres then searches it first).
-- With `public` first, an object created there with a built-in's name (a
-- function or operator) is found before the built-in and runs with the
-- owner's rights. Nothing like
-- that exists today, and users cannot create objects in `public` through the
-- API; this removes the possibility rather than relying on that.
--
-- pg_catalog first, then public (the functions' own tables, as before), then
-- pg_temp last: when pg_temp is not listed, Postgres searches it FIRST for
-- tables, which is the other half of the same advice for definer functions.
-- The function bodies are unchanged.
--
-- NOT APPLIED. The owner applies it. Idempotent: safe to run twice.

alter function public.purge_soft_deleted(interval) set search_path = pg_catalog, public, pg_temp;
alter function public.soft_deleted_pending(interval) set search_path = pg_catalog, public, pg_temp;
alter function public.erase_audit_log_for_user() set search_path = pg_catalog, public, pg_temp;

-- A later `create or replace` of any of these copied from its original
-- migration (20260729_retention_purge.sql, 20260926_client_errors.sql) would
-- bring the old search_path back with it: carry this setting into the copy.

-- Check afterwards (expect search_path=pg_catalog, public, pg_temp for all three):
--   select p.oid::regprocedure, p.proconfig from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('purge_soft_deleted', 'soft_deleted_pending', 'erase_audit_log_for_user');
