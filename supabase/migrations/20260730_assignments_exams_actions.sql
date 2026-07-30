-- StudyDesk: give assignments, exams and manual actions a cloud home.
--
-- Reported by a user 2026-07-30 (StudyDesk#6): courses and grades sync between
-- devices, assignments and manually added tasks do not. They never had a table
-- — sync.js only ever touched subjects, grades and study_sessions.
--
-- Additive only. Nothing existing is altered, so the working subjects/grades/
-- study_sessions paths cannot regress from this migration.
--
-- Shape deliberately mirrors public.grades: uuid pk, user_id, subject_id fk,
-- client-set updated_at for LWW, soft delete via deleted_at (never hard DELETE).

create table if not exists public.assignments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  title       text not null,
  -- free-form label from the local model ("homework", "project", ...). Kept as
  -- text rather than an enum so a future local type cannot fail the upsert.
  type        text,
  due_date    date,
  notes       text,
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists public.exams (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  title       text not null,
  due_date    date,
  difficulty  text,
  notes       text,
  done        boolean not null default false,
  -- Topics are a short list edited as part of the exam, never queried across
  -- exams, and carry their own local ids. A child table would buy nothing and
  -- cost a second sync path; jsonb keeps the exam atomic under LWW.
  topics      jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Named study_actions, not "actions" or "tasks": public.tasks already exists and
-- belongs to NCC. A bare "actions" in a shared project invites exactly the kind
-- of cross-app confusion the data contract exists to prevent.
create table if not exists public.study_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Nullable: a manual to-do need not belong to a course. set null rather than
  -- cascade so deleting a course orphans the task instead of destroying it.
  subject_id  uuid references public.subjects(id) on delete set null,
  text        text not null,
  bucket      text not null default 'today',
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Pull path is always "mine, changed since": index accordingly.
create index if not exists assignments_user_updated_idx   on public.assignments   (user_id, updated_at);
create index if not exists exams_user_updated_idx         on public.exams         (user_id, updated_at);
create index if not exists study_actions_user_updated_idx on public.study_actions (user_id, updated_at);
create index if not exists assignments_subject_idx        on public.assignments   (subject_id);
create index if not exists exams_subject_idx              on public.exams         (subject_id);

alter table public.assignments   enable row level security;
alter table public.exams         enable row level security;
alter table public.study_actions enable row level security;

-- One policy per command per table. RLS is the only barrier between the 178
-- accounts on this project, so this is written out explicitly rather than with
-- a permissive FOR ALL.
create policy assignments_select on public.assignments for select using (auth.uid() = user_id);
create policy assignments_insert on public.assignments for insert with check (auth.uid() = user_id);
create policy assignments_update on public.assignments for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy assignments_delete on public.assignments for delete using (auth.uid() = user_id);

create policy exams_select on public.exams for select using (auth.uid() = user_id);
create policy exams_insert on public.exams for insert with check (auth.uid() = user_id);
create policy exams_update on public.exams for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy exams_delete on public.exams for delete using (auth.uid() = user_id);

create policy study_actions_select on public.study_actions for select using (auth.uid() = user_id);
create policy study_actions_insert on public.study_actions for insert with check (auth.uid() = user_id);
create policy study_actions_update on public.study_actions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy study_actions_delete on public.study_actions for delete using (auth.uid() = user_id);
