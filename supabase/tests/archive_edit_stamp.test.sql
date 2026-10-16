-- StudyDesk#163 — behaviour tests for public.subjects_archive_edit_stamp(),
-- run against a real Postgres, never production. The subjects table gets the
-- triggers production has on it, by production's names (from the
-- realtime_echo_guard fixture), so the firing order is the real one.
--
-- Run (throwaway container; loading the migration twice checks it re-runs):
--   docker run -d --rm --name arctest -e POSTGRES_PASSWORD=x postgres:17
--   docker cp supabase arctest:/work
--   docker exec arctest psql -U postgres -q \
--     -f /work/migrations/20260925_lww_clamp_delete_wins.sql \
--     -f /work/tests/realtime_echo_guard.fixture.sql \
--     -f /work/migrations/20261006_realtime_echo_guard.sql \
--     -f /work/tests/archive_edit_stamp.fixture.sql \
--     -f /work/migrations/20261016_archive_edit_stamp.sql \
--     -f /work/migrations/20261016_archive_edit_stamp.sql \
--     -f /work/tests/archive_edit_stamp.test.sql
--   docker rm -f arctest
--
-- Prints one PASS/FAIL line per check and ends with a summary; exits non-zero
-- (via the final RAISE) if anything failed.

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

-- Rows an UPDATE wrote, as PostgREST's `.update().select()` reports them.
create or replace function pg_temp.run(q text) returns int
language plpgsql as $$
declare n int;
begin
  execute q;
  get diagnostics n = row_count;
  return n;
end $$;

-- Runs q, then evaluates cond. (In one expression an uncorrelated subquery
-- would be evaluated before the UPDATE ran.)
create or replace function pg_temp.after(q text, rows int, cond text) returns boolean
language plpgsql as $$
declare ok boolean;
begin
  if pg_temp.run(q) <> rows then
    return false;
  end if;
  execute 'select ' || cond into ok;
  return ok;
end $$;

create or replace function pg_temp.h(n numeric) returns timestamptz
language sql as $$ select date_trunc('second', now()) - make_interval(secs => n * 3600) $$;

-- ── 0. Wiring ───────────────────────────────────────────────────────────────
select pg_temp.check('the guard runs first, then set_updated_at, then the no-op guard',
  (select array_agg(tgname::text order by tgname) = array['subjects_archive_edit_stamp', 'subjects_updated_at', 'zz_skip_noop_update']
     from pg_trigger where tgrelid = 'public.subjects'::regclass and not tgisinternal and tgtype & 2 = 2));
select pg_temp.check('loading the migration twice leaves one guard',
  (select count(*) = 1 from pg_trigger where tgname = 'subjects_archive_edit_stamp'));

-- ── 1. The StudyDesk#163 scenario, 1.18.1 on both devices ──────────────────
insert into public.subjects (id, content, updated_at) values (1, 'Math', pg_temp.h(5));
select pg_temp.check('an archive lands, stamped with its edit time',
  pg_temp.after($q$update public.subjects set archived_at = pg_temp.h(4), archived_edited_at = pg_temp.h(4) where id = 1$q$, 1,
    $c$(select archived_at = pg_temp.h(4) and archived_edited_at = pg_temp.h(4) from public.subjects where id = 1)$c$));
select pg_temp.check('...and moves updated_at by 1 ms only',
  (select updated_at = pg_temp.h(5) + interval '1 millisecond' from public.subjects where id = 1));
-- B restores at 11:00 (here: 3 h ago).
select pg_temp.check('B''s restore lands',
  pg_temp.after($q$update public.subjects set archived_at = null, archived_edited_at = pg_temp.h(3) where id = 1$q$, 1,
    $c$(select archived_at is null from public.subjects where id = 1)$c$));
-- A's offline archive from 10:00 (3.5 h ago) is pushed now.
select pg_temp.check('A''s older offline archive, pushed later, is ignored and writes no row',
  pg_temp.after($q$update public.subjects set archived_at = pg_temp.h(3.5), archived_edited_at = pg_temp.h(3.5), updated_at = now() where id = 1$q$, 0,
    $c$(select archived_at is null and archived_edited_at = pg_temp.h(3) from public.subjects where id = 1)$c$));
-- B's offline rename from 11:30 (2.5 h ago) is pushed now.
select pg_temp.check('B''s later rename lands',
  pg_temp.after($q$update public.subjects set content = 'Mathematics', updated_at = pg_temp.h(2.5) where id = 1$q$, 1,
    $c$(select content = 'Mathematics' and archived_at is null from public.subjects where id = 1)$c$));

-- ── 2. (b) An archive does not decline a content edit made before its push ──
insert into public.subjects (id, content, updated_at) values (2, 'Math', pg_temp.h(5));
update public.subjects set archived_at = pg_temp.h(3), archived_edited_at = pg_temp.h(3), updated_at = now() where id = 2;
select pg_temp.check('an archive-only write ignores the updated_at it sends',
  (select updated_at = pg_temp.h(5) + interval '1 millisecond' from public.subjects where id = 2));
select pg_temp.check('a rename made before the archive, pushed after it, still lands and keeps the archive',
  pg_temp.after($q$update public.subjects set content = 'Mathematics', updated_at = pg_temp.h(4) where id = 2$q$, 1,
    $c$(select content = 'Mathematics' and archived_at = pg_temp.h(3) from public.subjects where id = 2)$c$));
select pg_temp.check('content is still last-writer-wins: an edit older than the stored one is declined',
  pg_temp.run($q$update public.subjects set content = 'Stale', updated_at = pg_temp.h(4.5) where id = 2$q$) = 0);

-- ── 3. P1: shipped clients (never send archived_edited_at) ─────────────────
-- The same legacy writes against a twin with only the triggers production
-- has today must leave the same rows (bar the new column).
create table public.subjects_ctl (like public.subjects);
create trigger subjects_updated_at before insert or update on public.subjects_ctl
  for each row execute function public.set_updated_at();
create trigger zz_skip_noop_update before update on public.subjects_ctl
  for each row execute function public.skip_noop_update();

create temp table legacy (n int, q text);
insert into legacy values
  (1, $q$insert into public.%I (id, content, updated_at) values (10, 'Math', pg_temp.h(6))$q$),
  (2, $q$update public.%I set archived_at = pg_temp.h(5), updated_at = pg_temp.h(5) where id = 10$q$),
  (3, $q$update public.%I set archived_at = null, updated_at = pg_temp.h(5.5) where id = 10$q$),
  (4, $q$update public.%I set content = 'Maths', updated_at = pg_temp.h(4) where id = 10$q$),
  (5, $q$update public.%I set archived_at = null, content = 'Old', updated_at = pg_temp.h(4.5) where id = 10$q$),
  (6, $q$update public.%I set archived_at = null, updated_at = now() + interval '1 day' where id = 10$q$),
  (7, $q$update public.%I set archived_at = now(), updated_at = pg_temp.h(1) where id = 10$q$),
  (8, $q$update public.%I set archived_at = now(), updated_at = now() where id = 10$q$),
  (9, $q$update public.%I set deleted_at = now(), archived_at = null, updated_at = pg_temp.h(3) where id = 10$q$);
create temp table outcome (n int, t text, affected int, row jsonb);
do $$
declare r record; t text; k int;
begin
  for r in select * from legacy order by n loop
    foreach t in array array['subjects', 'subjects_ctl'] loop
      k := pg_temp.run(format(r.q, t));
      execute format('insert into outcome select %s, %L, %s, to_jsonb(s) from public.%I s where id = 10', r.n, t, k, t);
    end loop;
  end loop;
end $$;
select pg_temp.check('legacy writes: every step affects and leaves the same rows as today',
  not exists (select 1 from outcome a join outcome b on a.n = b.n and a.t = 'subjects' and b.t = 'subjects_ctl'
               where a.affected <> b.affected or a.row - 'archived_edited_at' <> b.row - 'archived_edited_at'));
select pg_temp.check('legacy writes: an archive change is stamped with its own (clamped) updated_at',
  (select bool_and(row ->> 'archived_edited_at' = row ->> 'updated_at') from outcome
    where t = 'subjects' and n in (2, 6, 8)));

-- An old client restores at 11:00 (push time); a 1.18.1 archive from 10:00 arrives later.
insert into public.subjects (id, content, archived_at, updated_at) values (11, 'Math', pg_temp.h(9), pg_temp.h(9));
update public.subjects set archived_at = null, updated_at = pg_temp.h(3) where id = 11;
select pg_temp.check('old client''s restore, then a new client''s OLDER archive: the restore stays',
  pg_temp.after($q$update public.subjects set archived_at = pg_temp.h(3.5), archived_edited_at = pg_temp.h(3.5) where id = 11$q$, 0,
    $c$(select archived_at is null from public.subjects where id = 11)$c$));
select pg_temp.check('...and a new client''s NEWER archive lands',
  pg_temp.after($q$update public.subjects set archived_at = pg_temp.h(2), archived_edited_at = pg_temp.h(2) where id = 11$q$, 1,
    $c$(select archived_at = pg_temp.h(2) and archived_edited_at = pg_temp.h(2) from public.subjects where id = 11)$c$));

-- A 1.18.1 archive, then NCC pushes the whole course with its stale archived_at.
insert into public.subjects (id, content, updated_at) values (12, 'Math', pg_temp.h(5));
update public.subjects set archived_at = pg_temp.h(1), archived_edited_at = pg_temp.h(1) where id = 12;
select pg_temp.check('a legacy whole-row write older than the archive lands its content and keeps the archive',
  pg_temp.after($q$update public.subjects set content = 'Maths', archived_at = null, updated_at = pg_temp.h(2) where id = 12$q$, 1,
    $c$(select content = 'Maths' and archived_at = pg_temp.h(1) and archived_edited_at = pg_temp.h(1) from public.subjects where id = 12)$c$));
select pg_temp.check('a legacy write newer than the archive restores, as it does today',
  pg_temp.after($q$update public.subjects set archived_at = null, updated_at = now() where id = 12$q$, 1,
    $c$(select archived_at is null from public.subjects where id = 12)$c$));
select pg_temp.check('a write that names archived_edited_at = null cannot clear the stamp',
  pg_temp.after($q$update public.subjects set content = 'M', archived_edited_at = null, updated_at = now() where id = 12$q$, 1,
    $c$(select archived_edited_at is not null from public.subjects where id = 12)$c$));

-- ── 4. Clamp, insert, delete wins ──────────────────────────────────────────
insert into public.subjects (id, content, archived_at, archived_edited_at, updated_at)
  values (20, 'Math', now(), now() + interval '1 day', pg_temp.h(1));
select pg_temp.check('insert: a future archive stamp is clamped to now',
  (select archived_edited_at <= now() from public.subjects where id = 20));
insert into public.subjects (id, content, updated_at) values (21, 'Math', pg_temp.h(5));
update public.subjects set archived_at = now(), archived_edited_at = now() + interval '1 day' where id = 21;
select pg_temp.check('update: a future archive stamp is clamped, so it cannot lock the archive',
  pg_temp.after($q$update public.subjects set archived_at = null, archived_edited_at = now() where id = 21$q$, 1,
    $c$(select archived_at is null from public.subjects where id = 21)$c$));
insert into public.subjects (id, content, updated_at) values (22, 'Math', pg_temp.h(5));
update public.subjects set archived_at = pg_temp.h(1), archived_edited_at = pg_temp.h(1) where id = 22;
select pg_temp.check('a delete older than the archive still wins',
  pg_temp.after($q$update public.subjects set deleted_at = pg_temp.h(4), updated_at = pg_temp.h(4) where id = 22$q$, 1,
    $c$(select deleted_at is not null from public.subjects where id = 22)$c$));
insert into public.subjects (id, content, updated_at) values (23, 'Math', pg_temp.h(5));
update public.subjects set deleted_at = pg_temp.h(4), updated_at = pg_temp.h(4) where id = 23;
update public.subjects set archived_at = pg_temp.h(1), archived_edited_at = pg_temp.h(1) where id = 23;
select pg_temp.check('an archive cannot revive a tombstone',
  (select deleted_at is not null from public.subjects where id = 23));

-- ── 5. Whole-row upserts, as NCC and older StudyDesk builds send them ──────
-- PostgREST's upsert: INSERT ... ON CONFLICT DO UPDATE SET <the sent columns>.
insert into public.subjects (id, content, updated_at) values (30, 'Math', pg_temp.h(5));
update public.subjects set archived_at = pg_temp.h(2), archived_edited_at = pg_temp.h(2) where id = 30;
select pg_temp.check('upsert older than the archive: its stale archived_at is reverted, its content lands',
  pg_temp.after($q$insert into public.subjects (id, content, archived_at, updated_at) values (30, 'Maths', null, pg_temp.h(3))
                  on conflict (id) do update set content = excluded.content, archived_at = excluded.archived_at, updated_at = excluded.updated_at$q$, 1,
    $c$(select content = 'Maths' and archived_at = pg_temp.h(2) and archived_edited_at = pg_temp.h(2) from public.subjects where id = 30)$c$));
select pg_temp.check('upsert newer than the archive: it wins and stamps the archive with its updated_at',
  pg_temp.after($q$insert into public.subjects (id, content, archived_at, updated_at) values (30, 'Mathematics', null, pg_temp.h(1))
                  on conflict (id) do update set content = excluded.content, archived_at = excluded.archived_at, updated_at = excluded.updated_at$q$, 1,
    $c$(select content = 'Mathematics' and archived_at is null and archived_edited_at = pg_temp.h(1) from public.subjects where id = 30)$c$));
select pg_temp.check('upsert of a new course born archived, with no stamp: stamped with its updated_at',
  pg_temp.after($q$insert into public.subjects (id, content, archived_at, updated_at) values (31, 'Past', pg_temp.h(4), pg_temp.h(4))
                  on conflict (id) do update set content = excluded.content, archived_at = excluded.archived_at, updated_at = excluded.updated_at$q$, 1,
    $c$(select archived_edited_at = pg_temp.h(4) from public.subjects where id = 31)$c$));
select pg_temp.check('...so a stale stamped restore from before it is ignored',
  pg_temp.after($q$update public.subjects set archived_at = null, archived_edited_at = pg_temp.h(5) where id = 31$q$, 0,
    $c$(select archived_at = pg_temp.h(4) from public.subjects where id = 31)$c$));
insert into public.subjects (id, content, updated_at) values (32, 'Live', pg_temp.h(4));
select pg_temp.check('insert of an active course leaves the stamp empty',
  (select archived_edited_at is null from public.subjects where id = 32));

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
