-- limecore#14 — the production "before" state that 20260925_rls_initplan_fk_indexes.sql
-- is written against, reproduced for a throwaway Postgres. Policy expressions,
-- commands and roles are copied from production's pg_policies (2026-09-25);
-- columns are only the ones a policy, foreign key or test touches.
-- Verified 2026-09-25: the 39 policies this file creates on the 12 tables match
-- production's pg_policies exactly (same md5 over name, command,
-- permissiveness, roles and both expressions: b7edc1a5a107ebed5cda4885ea5da7eb).
--
-- Load order: this file, then the migration, then rls_initplan.test.sql.
-- Ends by snapshotting pg_policies, so the test can diff before against after.

\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- Supabase stand-ins: the two API roles and auth.uid() reading the JWT subject.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create schema private;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Referenced tables (their own policies are out of scope, so RLS stays off).
create table public.subjects       (id uuid primary key default gen_random_uuid(), user_id uuid not null);
create table public.study_sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null);
create table public.tasks          (id uuid primary key default gen_random_uuid(), user_id uuid not null);
create table public.budget_categories (id uuid primary key default gen_random_uuid(), user_id uuid not null);

create function private.owns_task(p_task_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.tasks where id = p_task_id and user_id = p_user_id);
$$;
create function private.owns_budget_category(p_cat_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.budget_categories where id = p_cat_id and user_id = p_user_id);
$$;
grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;

-- The eight StudyDesk tables with four owner-only policies each. Roles differ
-- in production: the v1.6.1 tables grant to public, the v1.10+ tables to
-- authenticated. Reproduced as they are, because the migration must keep them.
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['academic_terms','assignment_attachments','assignments','commitments',
                           'exams','planned_sessions','study_actions','timetable_entries'] loop
    r := case when t in ('assignments','commitments','exams','study_actions') then 'public' else 'authenticated' end;
    execute format('create table public.%I (id uuid primary key default gen_random_uuid(), user_id uuid not null, note text)', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to %s using (auth.uid() = user_id)', t || '_select', t, r);
    execute format('create policy %I on public.%I for insert to %s with check (auth.uid() = user_id)', t || '_insert', t, r);
    execute format('create policy %I on public.%I for update to %s using (auth.uid() = user_id) with check (auth.uid() = user_id)', t || '_update', t, r);
    execute format('create policy %I on public.%I for delete to %s using (auth.uid() = user_id)', t || '_delete', t, r);
  end loop;
end $$;

-- The five foreign keys the migration indexes, all `on delete set null` as in production.
alter table public.planned_sessions  add column subject_id uuid references public.subjects(id) on delete set null,
                                     add column fulfilled_by uuid references public.study_sessions(id) on delete set null;
alter table public.study_actions     add column subject_id uuid references public.subjects(id) on delete set null;
alter table public.timetable_entries add column subject_id uuid references public.subjects(id) on delete set null;
create table public.braindump_entries (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  converted_task_id uuid references public.tasks(id) on delete set null);

create table public.feedback (id uuid primary key default gen_random_uuid(), user_id uuid not null, body text);
alter table public.feedback enable row level security;
create policy feedback_select_own on public.feedback for select to public using (user_id = auth.uid());
create policy feedback_insert_own on public.feedback for insert to public with check (user_id = auth.uid());

create table public.supporter_entitlements (id uuid primary key default gen_random_uuid(), user_id uuid not null);
alter table public.supporter_entitlements enable row level security;
create policy supporter_entitlements_select_own on public.supporter_entitlements for select to authenticated using (auth.uid() = user_id);

-- The two share tables: an already-wrapped SELECT policy plus a FOR ALL one.
create table public.task_shares (task_id uuid not null, user_id uuid not null, granted_by uuid not null,
  permission text not null default 'view', created_at timestamptz not null default now(), primary key (task_id, user_id));
alter table public.task_shares enable row level security;
create policy task_shares_select on public.task_shares for select to authenticated
  using ((user_id = (select auth.uid())) or private.owns_task(task_id, (select auth.uid())));
create policy task_shares_modify on public.task_shares for all to authenticated
  using (private.owns_task(task_id, (select auth.uid())))
  with check (private.owns_task(task_id, (select auth.uid())) and (granted_by = (select auth.uid())));

create table public.budget_category_shares (category_id uuid not null, user_id uuid not null, granted_by uuid not null,
  permission text not null default 'view', created_at timestamptz not null default now(), primary key (category_id, user_id));
alter table public.budget_category_shares enable row level security;
create policy budget_category_shares_select on public.budget_category_shares for select to authenticated
  using ((user_id = (select auth.uid())) or private.owns_budget_category(category_id, (select auth.uid())));
create policy budget_category_shares_modify on public.budget_category_shares for all to authenticated
  using (private.owns_budget_category(category_id, (select auth.uid())))
  with check (private.owns_budget_category(category_id, (select auth.uid())) and (granted_by = (select auth.uid())));

grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- Snapshot for the diff. A real table, not a temp one, so the test can read it
-- after switching roles.
create table public.t_before as
  select tablename::text, policyname::text, cmd, permissive, roles::text as roles, qual, with_check
  from pg_policies where schemaname = 'public';
