-- limecore#14 — checks for 20260925_rls_initplan_fk_indexes.sql, run against a
-- real Postgres, never production.
--
-- Run (throwaway container):
--   docker run -d --rm --name rlstest -e POSTGRES_PASSWORD=x postgres:17
--   docker cp supabase rlstest:/work
--   docker exec rlstest psql -U postgres -q \
--     -f /work/tests/rls_initplan.fixture.sql \
--     -f /work/migrations/20260925_rls_initplan_fk_indexes.sql \
--     -f /work/tests/rls_initplan.test.sql
--   docker rm -f rlstest
--
-- One PASS/FAIL line per check, then a summary; the final RAISE makes psql exit
-- non-zero if anything failed. Loading the fixture and this file WITHOUT the
-- migration (or with a broken copy of it) is the mutation run.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
\o /dev/null

-- Real tables and invoker functions, so checks still run after `set role`.
create table public.t_results (label text, ok boolean);
grant insert on public.t_results to public;
create function public.t_check(label text, ok boolean) returns void language plpgsql as $$
begin
  insert into public.t_results values (label, coalesce(ok, false));
  raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label;
end $$;
-- Rows a statement touched, as the current role.
create function public.t_rows(stmt text) returns int language plpgsql as $$
declare n int;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end $$;
-- True when RLS refuses the statement outright.
create function public.t_refused(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when insufficient_privilege then
  return true;
end $$;
grant select on public.t_before to public;

-- ── 1. Every rewritten policy: same command, roles, permissiveness; the
--       expression differs ONLY by auth.uid() becoming (select auth.uid()). ──
create temp view policy_diff as
  select b.tablename, b.policyname,
         a.policyname is not null                                          as still_there,
         a.cmd = b.cmd and a.permissive = b.permissive and a.roles::text = b.roles as same_shape,
         coalesce(a.qual, '') = replace(coalesce(b.qual, ''), 'auth.uid()', '( SELECT auth.uid() AS uid)')
           and coalesce(a.with_check, '') = replace(coalesce(b.with_check, ''), 'auth.uid()', '( SELECT auth.uid() AS uid)')
                                                                           as same_predicate
  from public.t_before b
  left join pg_policies a on a.schemaname = 'public' and a.tablename = b.tablename and a.policyname = b.policyname
  -- The "before" policies that called auth.uid() unwrapped somewhere.
  where regexp_replace(coalesce(b.qual, '') || ' ' || coalesce(b.with_check, ''),
                       '\(\s*select\s+auth\.uid\(\)(\s+as\s+uid)?\s*\)', '', 'gi') ~ 'auth\.uid\(\)';

select public.t_check('the fixture reproduces the 35 policies the advisor flags',
  (select count(*) = 35 from policy_diff));
select public.t_check('all 35 still exist under the same names',
  (select bool_and(still_there) from policy_diff));
select public.t_check('all 35 keep their command, roles and permissiveness',
  (select bool_and(same_shape) from policy_diff));
select public.t_check('all 35 keep the same predicate, with auth.uid() wrapped',
  (select bool_and(same_predicate) from policy_diff));
do $$
declare r record;
begin
  for r in select * from policy_diff where not (still_there and same_shape and same_predicate) loop
    raise notice '  differs: %.%', r.tablename, r.policyname;
  end loop;
end $$;

select public.t_check('no public policy calls auth.uid() unwrapped any more',
  (select count(*) = 0 from pg_policies where schemaname = 'public' and (
     regexp_replace(coalesce(qual, ''), '\(\s*select\s+auth\.uid\(\)(\s+as\s+uid)?\s*\)', '', 'gi') ~ 'auth\.uid\(\)'
     or regexp_replace(coalesce(with_check, ''), '\(\s*select\s+auth\.uid\(\)(\s+as\s+uid)?\s*\)', '', 'gi') ~ 'auth\.uid\(\)')));

select public.t_check('policies the migration does not mention are untouched',
  (select bool_and(a.qual is not distinct from b.qual and a.with_check is not distinct from b.with_check
                   and a.cmd = b.cmd and a.roles::text = b.roles)
     from public.t_before b join pg_policies a
       on a.schemaname = 'public' and a.tablename = b.tablename and a.policyname = b.policyname
    where b.policyname in ('task_shares_select', 'budget_category_shares_select')));

-- ── 2. The share policies: FOR ALL split into three, same expressions ─────
select public.t_check('the two FOR ALL share policies are gone',
  (select count(*) = 0 from pg_policies where schemaname = 'public'
     and policyname in ('task_shares_modify', 'budget_category_shares_modify')));

select public.t_check('each share table has exactly one policy that applies to SELECT',
  (select bool_and(n = 1) from (
     select tablename, count(*) n from pg_policies
      where schemaname = 'public' and tablename in ('task_shares', 'budget_category_shares')
        and cmd in ('SELECT', 'ALL')
      group by tablename) s));

select public.t_check('insert/update/delete carry the old FOR ALL expressions exactly',
  (select bool_and(ok) from (
     select case a.cmd
              when 'INSERT' then a.qual is null and a.with_check = m.with_check
              when 'UPDATE' then a.qual = m.qual and a.with_check = m.with_check
              when 'DELETE' then a.qual = m.qual and a.with_check is null
            end
            and a.roles::text = m.roles and a.permissive = m.permissive as ok
       from public.t_before m
       join pg_policies a on a.schemaname = 'public' and a.tablename = m.tablename
        and a.policyname in (m.tablename || '_insert', m.tablename || '_update', m.tablename || '_delete')
      where m.policyname in ('task_shares_modify', 'budget_category_shares_modify')) s)
  and (select count(*) = 6 from pg_policies where schemaname = 'public'
        and tablename in ('task_shares', 'budget_category_shares') and cmd in ('INSERT', 'UPDATE', 'DELETE')));

-- ── 3. The five foreign keys each have an index led by their column ──────
select public.t_check('all five foreign keys now have a covering index',
  (select count(*) = 5 from pg_constraint c
    where c.contype = 'f'
      and c.conname in ('braindump_entries_converted_task_id_fkey', 'planned_sessions_fulfilled_by_fkey',
                        'planned_sessions_subject_id_fkey', 'study_actions_subject_id_fkey',
                        'timetable_entries_subject_id_fkey')
      and exists (select 1 from pg_index i
                   where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])));

-- ── 4. Behaviour: who sees and writes what, as real API roles ─────────────
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
insert into public.assignments (user_id, note) values (:A, 'A1'), (:A, 'A2'), (:B, 'B1');
insert into public.timetable_entries (user_id, note) values (:A, 'A1'), (:B, 'B1');
insert into public.feedback (user_id, body) values (:A, 'a'), (:B, 'b');
insert into public.tasks (id, user_id) values ('11111111-0000-0000-0000-00000000000a', :A),
                                              ('11111111-0000-0000-0000-00000000000b', :B);

set role authenticated;
select set_config('request.jwt.claim.sub', :A, false);

select public.t_check('A sees only A''s rows (public-role table)',
  (select count(*) = 2 and bool_and(user_id = :A) from public.assignments));
select public.t_check('A sees only A''s rows (authenticated-role table)',
  (select count(*) = 1 and bool_and(user_id = :A) from public.timetable_entries));
select public.t_check('A sees only A''s feedback',
  (select count(*) = 1 from public.feedback));
select public.t_check('A cannot insert a row owned by B',
  public.t_refused(format('insert into public.exams (user_id) values (%L)', :B)));
select public.t_check('A can insert a row of their own',
  public.t_rows(format('insert into public.exams (user_id) values (%L)', :A)) = 1);
select public.t_check('A cannot update B''s row (0 rows)',
  public.t_rows('update public.assignments set note = ''x'' where note = ''B1''') = 0);
select public.t_check('A cannot hand their row to B',
  public.t_refused(format('update public.assignments set user_id = %L where note = ''A1''', :B)));
select public.t_check('A cannot delete B''s row (0 rows)',
  public.t_rows('delete from public.timetable_entries where note = ''B1''') = 0);

select public.t_check('A (owner) can share their task with B',
  public.t_rows(format('insert into public.task_shares (task_id, user_id, granted_by) values (%L, %L, %L)',
                       '11111111-0000-0000-0000-00000000000a', :B, :A)) = 1);
select public.t_check('A cannot share B''s task',
  public.t_refused(format('insert into public.task_shares (task_id, user_id, granted_by) values (%L, %L, %L)',
                          '11111111-0000-0000-0000-00000000000b', :A, :A)));
select public.t_check('A cannot record the share as granted by someone else',
  public.t_refused(format('insert into public.task_shares (task_id, user_id, granted_by) values (%L, %L, %L)',
                          '11111111-0000-0000-0000-00000000000a', gen_random_uuid(), :B)));
select public.t_check('A (owner) can update the share',
  public.t_rows('update public.task_shares set permission = ''edit''') = 1);

select set_config('request.jwt.claim.sub', :B, false);
select public.t_check('B (grantee) can read the share',
  (select count(*) = 1 from public.task_shares));
select public.t_check('B (grantee) cannot change the share (0 rows)',
  public.t_rows('update public.task_shares set permission = ''owner''') = 0);
select public.t_check('B (grantee) cannot delete the share (0 rows)',
  public.t_rows('delete from public.task_shares') = 0);

select set_config('request.jwt.claim.sub', :A, false);
select public.t_check('A (owner) can delete the share',
  public.t_rows('delete from public.task_shares') = 1);

-- The point of the change: auth.uid() runs once per statement, as an InitPlan.
create temp table plan_lines (line text);
do $$
declare l text;
begin
  for l in execute 'explain select * from public.assignments' loop
    insert into plan_lines values (l);
  end loop;
end $$;
select public.t_check('the planner evaluates auth.uid() once, as an InitPlan',
  (select count(*) > 0 from plan_lines where line ~ 'InitPlan'));

select set_config('request.jwt.claim.sub', '', false);
set role anon;
select public.t_check('a signed-out caller sees nothing',
  (select count(*) = 0 from public.assignments) and (select count(*) = 0 from public.feedback));
reset role;

\o
do $$
declare
  passed int;
  total int;
begin
  select count(*) filter (where ok), count(*) into passed, total from public.t_results;
  raise notice '% / % checks passed', passed, total;
  if passed < total then
    raise exception 'limecore#14 migration tests failed';
  end if;
end $$;
