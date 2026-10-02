-- limecore#27 — behaviour tests for public.set_updated_at() and step 2's
-- trigger attachment, run against a real Postgres, never production.
--
-- Run (throwaway container; the function under test is loaded first):
--   docker run -d --rm --name lwwtest -e POSTGRES_PASSWORD=x postgres:17
--   docker cp supabase lwwtest:/work
--   docker exec lwwtest psql -U postgres -q \
--     -f /work/migrations/20260925_lww_clamp_delete_wins.sql \
--     -f /work/tests/lww_guard.test.sql
--   docker rm -f lwwtest
--
-- Prints one PASS/FAIL line per check and ends with a summary; exits non-zero
-- (via the final RAISE) if anything failed. Loading a different definition of
-- set_updated_at() first is how a mutation run checks these tests catch the
-- old behaviour.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
-- Results go to NOTICE; the result rows of each check are noise.
\o /dev/null

create temp table results (label text, ok boolean);
create or replace function pg_temp.check(label text, ok boolean) returns void
language plpgsql as $$
begin
  insert into results values (label, coalesce(ok, false));
  raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label;
end $$;

-- Stand-ins for the three table shapes the guard meets in production.
create table public.g (id int primary key, content text, updated_at timestamptz, deleted_at timestamptz);
create table public.p (id int primary key, content text, updated_at timestamptz);  -- no deleted_at, like profiles
create table public.a (                                                              -- like lesson_attendance
  id uuid primary key default gen_random_uuid(),
  k text unique, status text, updated_at timestamptz, deleted_at timestamptz);
create trigger g_guard before insert or update on public.g for each row execute function public.set_updated_at();
create trigger p_guard before insert or update on public.p for each row execute function public.set_updated_at();
create trigger a_guard before insert or update on public.a for each row execute function public.set_updated_at();

-- ── 1. Clamp ────────────────────────────────────────────────────────────────
insert into public.g values (1, 'future', now() + interval '1 day', null);
select pg_temp.check('insert: a future stamp is clamped to now',
  (select updated_at <= now() from public.g where id = 1));

insert into public.g values (2, 'nostamp', null, null);
select pg_temp.check('insert: a missing stamp becomes now',
  (select updated_at is not null and updated_at <= now() from public.g where id = 2));

insert into public.g values (3, 'B', now() - interval '1 hour', null);
update public.g set content = 'future edit', updated_at = now() + interval '1 day' where id = 3;
select pg_temp.check('update: a future stamp is clamped, so it cannot lock the row',
  (select updated_at <= now() from public.g where id = 3));

-- ── 2. Last-writer-wins — the limecore#27 scenario ─────────────────────────
-- B edited online at 11:00; A's edit was made offline at 10:00 and pushes late.
insert into public.g values (10, 'B at 11:00', now() - interval '1 hour', null);
update public.g set content = 'A at 10:00', updated_at = now() - interval '2 hours' where id = 10;
select pg_temp.check('a late push of an OLDER edit does not overwrite a newer one',
  (select content = 'B at 11:00' from public.g where id = 10));

update public.g set content = 'A at 12:00', updated_at = now() where id = 10;
select pg_temp.check('a newer edit is applied',
  (select content = 'A at 12:00' from public.g where id = 10));

-- PostgREST's upsert shape: INSERT ... ON CONFLICT (id) DO UPDATE SET ...
insert into public.g (id, content, updated_at) values (10, 'stale upsert', now() - interval '3 hours')
  on conflict (id) do update set content = excluded.content, updated_at = excluded.updated_at;
select pg_temp.check('a stale PostgREST-style upsert is declined',
  (select content = 'A at 12:00' from public.g where id = 10));

insert into public.g values (11, 'old', now() - interval '3 hours', null);
update public.g set content = 'no stamp sent' where id = 11;
select pg_temp.check('an update that sends no stamp is applied and keeps the stored stamp',
  (select content = 'no stamp sent' and updated_at < now() - interval '2 hours' from public.g where id = 11));

-- ── 3. Delete wins ─────────────────────────────────────────────────────────
-- Live row edited at 11:00; a delete made offline at 10:00 arrives late.
insert into public.g values (20, 'edited at 11:00', now() - interval '1 hour', null);
update public.g set deleted_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' where id = 20;
select pg_temp.check('DELETE WINS: an older tombstone still lands on a newer live row',
  (select deleted_at is not null from public.g where id = 20));
select pg_temp.check('the tombstone is stamped at least as new as the row it replaced',
  (select updated_at >= now() - interval '1 hour' - interval '1 second' from public.g where id = 20));

update public.g set content = 'edit that never saw the delete', updated_at = now() where id = 20;
select pg_temp.check('a content edit that does not mention deleted_at cannot un-delete',
  (select deleted_at is not null from public.g where id = 20));

update public.g set deleted_at = now(), updated_at = now() - interval '5 hours' where id = 20;
select pg_temp.check('a stale re-delete is declined and the first tombstone kept',
  (select deleted_at < now() - interval '1 hour' from public.g where id = 20));

-- ── 4. Revival is last-writer-wins (attendance re-marking, P1) ─────────────
insert into public.g values (30, 'cleared', now() - interval '1 hour', now() - interval '1 hour');
update public.g set deleted_at = null, updated_at = now() - interval '2 hours' where id = 30;
select pg_temp.check('an OLDER revival is declined — the delete stands',
  (select deleted_at is not null from public.g where id = 30));
update public.g set deleted_at = null, updated_at = now() where id = 30;
select pg_temp.check('a NEWER revival is applied',
  (select deleted_at is null from public.g where id = 30));

-- The real shape: StudyDesk re-marks a cleared lesson by upserting on the
-- natural key with deleted_at: null (src/lib/sync.js upsertAttendance).
insert into public.a (k, status, updated_at) values ('lesson-1', 'present', now() - interval '3 hours');
update public.a set deleted_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' where k = 'lesson-1';
insert into public.a (k, status, deleted_at, updated_at) values ('lesson-1', 'absent', null, now())
  on conflict (k) do update set status = excluded.status, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at;
select pg_temp.check('re-marking a cleared attendance lesson still works (natural-key upsert)',
  (select deleted_at is null and status = 'absent' from public.a where k = 'lesson-1'));
select pg_temp.check('...and it is still one row for one lesson',
  (select count(*) = 1 from public.a where k = 'lesson-1'));

-- ── 5. Tables without deleted_at ───────────────────────────────────────────
insert into public.p values (1, 'new', now() - interval '1 hour');
update public.p set content = 'stale', updated_at = now() - interval '2 hours' where id = 1;
select pg_temp.check('no deleted_at column: a stale update is declined, and nothing throws',
  (select content = 'new' from public.p where id = 1));
update public.p set content = 'fresh', updated_at = now() where id = 1;
select pg_temp.check('no deleted_at column: a newer update is applied',
  (select content = 'fresh' from public.p where id = 1));

-- ── 6. A row already stamped in the future heals ───────────────────────────
alter table public.g disable trigger g_guard;
insert into public.g values (40, 'locked', now() + interval '30 days', null);
alter table public.g enable trigger g_guard;
update public.g set content = 'correct clock', updated_at = now() where id = 40;
select pg_temp.check('a pre-existing future stamp no longer locks the row',
  (select content = 'correct clock' from public.g where id = 40));

-- ── 7. Step 2: the trigger attaches to all 12 unguarded tables, idempotently ─
do $$
declare t text;
begin
  foreach t in array array['academic_terms','assignment_attachments','assignments','braindump_entries',
    'commitments','exams','lesson_attendance','notebook_attachments','notebook_entries',
    'planned_sessions','study_actions','timetable_entries'] loop
    execute format('create table public.%I (id uuid primary key, content text, updated_at timestamptz, deleted_at timestamptz)', t);
  end loop;
end $$;
\i /work/migrations/20260925_lww_guard_regime_c.sql
\i /work/migrations/20260925_lww_guard_regime_c.sql
select pg_temp.check('step 2 attaches exactly one guard to each of the 12 tables, even when run twice',
  (select count(*) = 12 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
    where f.proname = 'set_updated_at' and not t.tgisinternal
      and t.tgrelid::regclass::text in ('academic_terms','assignment_attachments','assignments','braindump_entries',
        'commitments','exams','lesson_attendance','notebook_attachments','notebook_entries',
        'planned_sessions','study_actions','timetable_entries')));

insert into public.assignments values ('00000000-0000-0000-0000-000000000001', 'B at 11:00', now() - interval '1 hour', null);
update public.assignments set content = 'A at 10:00', updated_at = now() - interval '2 hours'
  where id = '00000000-0000-0000-0000-000000000001';
select pg_temp.check('assignments (was unguarded): the late offline snapshot no longer overwrites',
  (select content = 'B at 11:00' from public.assignments where id = '00000000-0000-0000-0000-000000000001'));

-- ── Summary ────────────────────────────────────────────────────────────────
do $$
declare failed int; total int;
begin
  select count(*) filter (where not ok), count(*) into failed, total from results;
  if failed > 0 then
    raise exception '% of % checks FAILED', failed, total;
  end if;
  raise notice 'ALL % CHECKS PASSED', total;
end $$;
