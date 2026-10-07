-- limecore#24 — behaviour tests for public.skip_noop_update() and the
-- Realtime publication migration, run against a real Postgres, never
-- production.
--
-- Run (throwaway container):
--   docker run -d --rm --name rttest -e POSTGRES_PASSWORD=x postgres:17
--   docker cp supabase rttest:/work
--   docker exec rttest psql -U postgres -q \
--     -f /work/migrations/20260925_lww_clamp_delete_wins.sql \
--     -f /work/tests/realtime_echo_guard.fixture.sql \
--     -f /work/migrations/20261006_realtime_echo_guard.sql \
--     -f /work/migrations/20261006_realtime_publish.sql \
--     -f /work/tests/realtime_echo_guard.test.sql
--   docker rm -f rttest
--
-- Prints one PASS/FAIL line per check and ends with a summary; exits non-zero
-- (via the final RAISE) if anything failed. "Wrote no row" is checked through
-- xmin: an UPDATE that writes a row version, even an identical one, changes it.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
\o /dev/null

create temp table results (label text, ok boolean);
create or replace function pg_temp.check(label text, ok boolean) returns void
language plpgsql as $$
begin
  insert into results values (label, coalesce(ok, false));
  raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label;
end $$;

create temp table bound (t text);
insert into bound select unnest(array[
  'subjects', 'grades', 'study_sessions', 'assignments', 'exams', 'study_actions',
  'planned_sessions', 'academic_terms', 'timetable_entries', 'assignment_attachments',
  'commitments', 'notebook_entries', 'notebook_attachments', 'lesson_attendance',
  'transactions', 'portfolio_holdings', 'workout_sessions', 'workout_sets',
  'portfolio_lots', 'manual_assets', 'watchlist_items', 'goals',
  'habits', 'habit_completions', 'body_metrics',
  'budget_categories', 'budget_category_shares', 'tasks', 'task_shares']);

-- ── 1. Wiring ───────────────────────────────────────────────────────────────
select pg_temp.check('the guard is on all 29 bound tables',
  (select count(*) = 29 from bound b where exists (
     select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
     where c.relname = b.t and g.tgname = 'zz_skip_noop_update')));

-- BEFORE UPDATE row triggers fire in name order; the guard must be last.
select pg_temp.check('the guard fires after every other BEFORE UPDATE trigger',
  not exists (
    select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
    where c.relname in (select t from bound) and not g.tgisinternal
      and g.tgtype & 2 = 2 and g.tgtype & 16 = 16          -- BEFORE, UPDATE
      and g.tgname > 'zz_skip_noop_update'));

select pg_temp.check('all 29 bound tables are published',
  (select count(*) = 29 from bound b where exists (
     select 1 from pg_publication_tables p
     where p.pubname = 'supabase_realtime' and p.tablename = b.t)));

-- ── 2. The echo: same content, newer stamp ───────────────────────────────────
insert into public.assignments values (1, null, 'A', now() - interval '1 hour', null);
create temp table snap as select xmin::text x, updated_at from public.assignments where id = 1;

with u as (update public.assignments set updated_at = now() - interval '1 minute' where id = 1 returning 1)
select pg_temp.check('an update that only moves updated_at affects 0 rows', (select count(*) = 0 from u));
select pg_temp.check('... and writes no row version (no WAL, no Realtime event)',
  (select a.xmin::text = s.x and a.updated_at = s.updated_at from public.assignments a, snap s where a.id = 1));

-- The shape StudyDesk <=1.15.0 actually sends: an upsert of the whole row.
with u as (
  insert into public.assignments values (1, null, 'A', now() - interval '30 seconds', null)
  on conflict (id) do update set user_id = excluded.user_id, content = excluded.content,
    updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
  returning 1)
select pg_temp.check('an upsert re-sending the same row affects 0 rows', (select count(*) = 0 from u));
select pg_temp.check('... and writes no row version',
  (select a.xmin::text = s.x from public.assignments a, snap s where a.id = 1));

-- ── 3. Real changes still land ──────────────────────────────────────────────
with u as (update public.assignments set content = 'B', updated_at = now() - interval '20 seconds' where id = 1 returning 1)
select pg_temp.check('a content change lands', (select count(*) = 1 from u));
select pg_temp.check('... with its stamp',
  (select content = 'B' and updated_at > now() - interval '21 seconds' from public.assignments where id = 1));

with u as (
  insert into public.assignments values (1, null, 'C', now() - interval '10 seconds', null)
  on conflict (id) do update set content = excluded.content, updated_at = excluded.updated_at
  returning 1)
select pg_temp.check('an upsert with new content lands', (select count(*) = 1 from u));

update public.assignments set deleted_at = now(), updated_at = now() - interval '2 hours' where id = 1;
select pg_temp.check('a tombstone lands, even with an old stamp (delete wins)',
  (select deleted_at is not null from public.assignments where id = 1));

update public.assignments set deleted_at = null, updated_at = now() where id = 1;
select pg_temp.check('a revival lands',
  (select deleted_at is null from public.assignments where id = 1));

-- ── 4. A stale last-writer-wins loser writes nothing ────────────────────────
truncate snap;
insert into snap select xmin::text, updated_at from public.assignments where id = 1;
with u as (update public.assignments set content = 'stale', updated_at = now() - interval '1 day' where id = 1 returning 1)
select pg_temp.check('a stale update (set_updated_at returns OLD) affects 0 rows', (select count(*) = 0 from u));
select pg_temp.check('... and writes no row version',
  (select a.xmin::text = s.x and a.content = 'C' from public.assignments a, snap s where a.id = 1));

-- ── 5. Tables whose trigger stamps now() (habits, body_metrics) ──────────────
insert into public.habits values (1, null, 'walk', now() - interval '1 hour', null);
truncate snap;
insert into snap select xmin::text, updated_at from public.habits where id = 1;
with u as (update public.habits set content = 'walk' where id = 1 returning 1)
select pg_temp.check('habits: re-sending the same row affects 0 rows', (select count(*) = 0 from u));
select pg_temp.check('... and keeps its stamp',
  (select h.xmin::text = s.x and h.updated_at = s.updated_at from public.habits h, snap s where h.id = 1));
with u as (update public.habits set content = 'run' where id = 1 returning 1)
select pg_temp.check('habits: a change lands', (select count(*) = 1 from u));
select pg_temp.check('... and is stamped now()',
  (select content = 'run' and updated_at > now() - interval '1 second' from public.habits where id = 1));

-- ── 6. Tables without updated_at (workout_sets, the share tables) ────────────
insert into public.workout_sets (id, content) values (1, 'x');
with u as (update public.workout_sets set content = 'x' where id = 1 returning 1)
select pg_temp.check('an update that changes nothing at all affects 0 rows', (select count(*) = 0 from u));
with u as (update public.workout_sets set content = 'y' where id = 1 returning 1)
select pg_temp.check('... and a real one lands', (select count(*) = 1 from u));

-- ── 7. Re-running both migrations is harmless ───────────────────────────────
\i /work/migrations/20261006_realtime_echo_guard.sql
\i /work/migrations/20261006_realtime_publish.sql
select pg_temp.check('re-running keeps exactly one guard per table',
  (select count(*) = 29 from pg_trigger where tgname = 'zz_skip_noop_update'));

-- ── Summary ─────────────────────────────────────────────────────────────────
\o
do $$
declare
  failed int := (select count(*) from results where not ok);
  total int := (select count(*) from results);
begin
  raise notice '% / % passed', total - failed, total;
  if failed > 0 then
    raise exception '% check(s) failed', failed;
  end if;
end $$;
