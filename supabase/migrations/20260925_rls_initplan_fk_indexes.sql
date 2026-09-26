-- limecore#14 — database hygiene for v1.16. One migration, three parts. No
-- column changes (P1) and no change to who can see or write what (P2).
--
-- Sequenced after limecore#27's migrations (20260925_lww_*), as the v1.16 plan
-- requires. They touch different objects (a trigger function and triggers,
-- not policies or indexes), so the order is for review, not correctness.
--
-- 1. INITPLAN. 35 policies call `auth.uid()` bare, which Postgres re-evaluates
--    for every row it checks. Wrapping it as `(select auth.uid())` makes it an
--    InitPlan, evaluated once per statement. The value is identical within a
--    statement, so each policy admits exactly the same rows as before. Every
--    other table in the project already uses the wrapped form (migration
--    `rls_initplan_wrap_auth_uid_in_select`, 2026-07-14); these 35 arrived in
--    later migrations that copied the bare form. `alter policy` keeps each
--    policy's name, command, roles and permissiveness; only the expression
--    changes.
--
-- 2. FK INDEXES. Five foreign keys have no covering index. All five are
--    `on delete set null`, so every delete of a subject, study session or task
--    — including the weekly `purge_soft_deleted()` hard-delete — scans the
--    referencing table to null them out. The tables are small today (at most
--    ~525 rows, measured 2026-09-25), so a plain CREATE INDEX inside the
--    migration transaction is brief; CONCURRENTLY is not allowed in one.
--
-- 3. OVERLAPPING SELECT. `task_shares_modify` and `budget_category_shares_modify`
--    are FOR ALL, so they also apply to SELECT, where `*_select` already covers
--    the same owners (its `or private.owns_*(...)` branch). Postgres evaluates
--    both on every read. Each is replaced by separate INSERT, UPDATE and DELETE
--    policies with the same expressions, so reads are governed by `*_select`
--    alone and writes exactly as before:
--      insert: with check  owns(row) and granted_by = me
--      update: using owns(row), with check owns(row) and granted_by = me
--      delete: using owns(row)
--
-- Tested against Postgres 17 before review: supabase/tests/rls_initplan.test.sql
-- (a before/after diff of every policy, plus row-level behaviour as two users).
-- APPLIED to production 2026-09-26 (owner-confirmed) as `v116_rls_initplan_fk_indexes`, version 20260926102231.

-- ── 1. Initplan: 35 policies, same predicate, `auth.uid()` evaluated once ────
alter policy academic_terms_select on public.academic_terms using ((select auth.uid()) = user_id);
alter policy academic_terms_insert on public.academic_terms with check ((select auth.uid()) = user_id);
alter policy academic_terms_update on public.academic_terms using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy academic_terms_delete on public.academic_terms using ((select auth.uid()) = user_id);

alter policy assignment_attachments_select on public.assignment_attachments using ((select auth.uid()) = user_id);
alter policy assignment_attachments_insert on public.assignment_attachments with check ((select auth.uid()) = user_id);
alter policy assignment_attachments_update on public.assignment_attachments using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy assignment_attachments_delete on public.assignment_attachments using ((select auth.uid()) = user_id);

alter policy assignments_select on public.assignments using ((select auth.uid()) = user_id);
alter policy assignments_insert on public.assignments with check ((select auth.uid()) = user_id);
alter policy assignments_update on public.assignments using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy assignments_delete on public.assignments using ((select auth.uid()) = user_id);

alter policy commitments_select on public.commitments using ((select auth.uid()) = user_id);
alter policy commitments_insert on public.commitments with check ((select auth.uid()) = user_id);
alter policy commitments_update on public.commitments using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy commitments_delete on public.commitments using ((select auth.uid()) = user_id);

alter policy exams_select on public.exams using ((select auth.uid()) = user_id);
alter policy exams_insert on public.exams with check ((select auth.uid()) = user_id);
alter policy exams_update on public.exams using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy exams_delete on public.exams using ((select auth.uid()) = user_id);

alter policy planned_sessions_select on public.planned_sessions using ((select auth.uid()) = user_id);
alter policy planned_sessions_insert on public.planned_sessions with check ((select auth.uid()) = user_id);
alter policy planned_sessions_update on public.planned_sessions using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy planned_sessions_delete on public.planned_sessions using ((select auth.uid()) = user_id);

alter policy study_actions_select on public.study_actions using ((select auth.uid()) = user_id);
alter policy study_actions_insert on public.study_actions with check ((select auth.uid()) = user_id);
alter policy study_actions_update on public.study_actions using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy study_actions_delete on public.study_actions using ((select auth.uid()) = user_id);

alter policy timetable_entries_select on public.timetable_entries using ((select auth.uid()) = user_id);
alter policy timetable_entries_insert on public.timetable_entries with check ((select auth.uid()) = user_id);
alter policy timetable_entries_update on public.timetable_entries using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy timetable_entries_delete on public.timetable_entries using ((select auth.uid()) = user_id);

alter policy feedback_select_own on public.feedback using (user_id = (select auth.uid()));
alter policy feedback_insert_own on public.feedback with check (user_id = (select auth.uid()));

alter policy supporter_entitlements_select_own on public.supporter_entitlements using ((select auth.uid()) = user_id);

-- ── 2. Covering indexes for the five unindexed foreign keys ─────────────────
create index if not exists braindump_entries_converted_task_idx on public.braindump_entries (converted_task_id);
create index if not exists planned_sessions_fulfilled_by_idx    on public.planned_sessions (fulfilled_by);
create index if not exists planned_sessions_subject_idx         on public.planned_sessions (subject_id);
create index if not exists study_actions_subject_idx            on public.study_actions (subject_id);
create index if not exists timetable_entries_subject_idx        on public.timetable_entries (subject_id);

-- ── 3. Split the two FOR ALL share policies into INSERT / UPDATE / DELETE ────
drop policy if exists task_shares_modify on public.task_shares;
create policy task_shares_insert on public.task_shares for insert to authenticated
  with check (private.owns_task(task_id, (select auth.uid())) and granted_by = (select auth.uid()));
create policy task_shares_update on public.task_shares for update to authenticated
  using (private.owns_task(task_id, (select auth.uid())))
  with check (private.owns_task(task_id, (select auth.uid())) and granted_by = (select auth.uid()));
create policy task_shares_delete on public.task_shares for delete to authenticated
  using (private.owns_task(task_id, (select auth.uid())));

drop policy if exists budget_category_shares_modify on public.budget_category_shares;
create policy budget_category_shares_insert on public.budget_category_shares for insert to authenticated
  with check (private.owns_budget_category(category_id, (select auth.uid())) and granted_by = (select auth.uid()));
create policy budget_category_shares_update on public.budget_category_shares for update to authenticated
  using (private.owns_budget_category(category_id, (select auth.uid())))
  with check (private.owns_budget_category(category_id, (select auth.uid())) and granted_by = (select auth.uid()));
create policy budget_category_shares_delete on public.budget_category_shares for delete to authenticated
  using (private.owns_budget_category(category_id, (select auth.uid())));

-- ── Post-condition: abort the whole migration if any public policy still
--    calls auth.uid() unwrapped, or if either FOR ALL share policy survived. ──
do $$
declare
  bare int;
  modify_left int;
begin
  select count(*) into bare from pg_policies
   where schemaname = 'public'
     and (   regexp_replace(coalesce(qual, ''),       '\(\s*select\s+auth\.uid\(\)(\s+as\s+uid)?\s*\)', '', 'gi') ~ 'auth\.uid\(\)'
          or regexp_replace(coalesce(with_check, ''), '\(\s*select\s+auth\.uid\(\)(\s+as\s+uid)?\s*\)', '', 'gi') ~ 'auth\.uid\(\)');
  select count(*) into modify_left from pg_policies
   where schemaname = 'public' and policyname in ('task_shares_modify', 'budget_category_shares_modify');
  if bare > 0 or modify_left > 0 then
    raise exception 'limecore#14 post-condition failed: % unwrapped auth.uid() policies, % FOR ALL share policies left', bare, modify_left;
  end if;
end $$;
