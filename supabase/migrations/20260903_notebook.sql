-- StudyDesk v1.13 Item 1b — the Notebook.
--
-- Shape comes from NEXUS_V111_BUILD_PLAN.md Item 11 and is NOT re-derived
-- here: `notebook_entries` (user_id, course_id FK, nullable lesson_date,
-- content) plus `notebook_attachments` mirroring `assignment_attachments`.
--
-- ── APPLY THIS BEFORE THE APP BUILD REACHES USERS ─────────────────────────
-- Not applied by the builder. `P1` in the version registry is explicit that
-- migrations go through `apply_migration` against production, and the owner
-- rule is that Supabase DDL is confirmed first. The client degrades cleanly
-- until it lands: `pullAllStudyData` treats a missing-table error on the
-- notebook selects as "no notes yet" rather than failing the whole pull, so
-- an app shipped ahead of this migration loses the feature and nothing else.
--
-- Additive only, per `P1`. Two new tables, no ALTER of anything existing, so
-- no shipped app version can regress from applying it.

create table if not exists public.notebook_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Nullable, `set null` on delete. A note outlives the course it was filed
  -- under: deleting "Physics 2" at the end of a jakso must not destroy a term
  -- of revision notes. This is the one place the notebook deliberately
  -- diverges from assignments/exams, which cascade — losing an assignment
  -- with its course is fine, losing written work is not.
  course_id   uuid references public.subjects(id) on delete set null,
  title       text,
  -- Which lesson the note belongs to. Nullable because most notes are not
  -- tied to a date, and a date rather than a timestamptz because a lesson is
  -- a calendar day in the user's own timezone, not an instant.
  lesson_date date,
  -- The note itself: MARKDOWN SOURCE, verbatim, one string.
  --
  -- Not a serialised block tree, and the reason is a data-safety one rather
  -- than a taste one. A highlight is stored as its ROLE (`==x==`, `=2=x=2=`)
  -- and this format has no production for a colour at all — so it is
  -- structurally incapable of stranding a light-mode yellow on a black page,
  -- which the design handoff calls "the one decision here that is
  -- unrecoverable later". It is also diffable, exportable as-is, and cannot
  -- corrupt into a note that will not open: a bad parse yields a paragraph
  -- containing the literal characters the user typed.
  content     text not null default '',
  -- The study session this note was written during, when there was one.
  -- `set null` for the same reason as course_id. This is what makes the
  -- notebook part of the study app rather than a worse Obsidian: a session
  -- debrief can list what was written during it.
  session_id  uuid references public.study_sessions(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Mirrors assignment_attachments deliberately — same columns, same meanings,
-- so the existing upload/signed-URL path in userStorage.js works unchanged
-- and there is one attachment shape in this app rather than two.
create table if not exists public.notebook_attachments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Cascade here, unlike the note's own FKs: an attachment has no meaning
  -- without the note that embeds it, and orphaning one would leave a storage
  -- object nothing will ever reference or clean up.
  entry_id      uuid not null references public.notebook_entries(id) on delete cascade,
  storage_path  text not null,
  file_name     text not null,
  mime_type     text,
  size_bytes    bigint,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Pull is always "mine, changed since"; the tree groups by course.
create index if not exists notebook_entries_user_updated_idx on public.notebook_entries (user_id, updated_at);
create index if not exists notebook_entries_course_idx       on public.notebook_entries (course_id);
create index if not exists notebook_entries_session_idx      on public.notebook_entries (session_id);
create index if not exists notebook_attachments_entry_idx    on public.notebook_attachments (entry_id);
create index if not exists notebook_attachments_user_idx     on public.notebook_attachments (user_id, updated_at);

-- `P2`: a new table ships with RLS enabled and a policy in the SAME migration.
-- No exceptions, no "I'll add it after". These are people's revision notes —
-- a policy hole here is a real data breach.
alter table public.notebook_entries     enable row level security;
alter table public.notebook_attachments enable row level security;

create policy notebook_entries_select on public.notebook_entries for select using (auth.uid() = user_id);
create policy notebook_entries_insert on public.notebook_entries for insert with check (auth.uid() = user_id);
create policy notebook_entries_update on public.notebook_entries for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy notebook_entries_delete on public.notebook_entries for delete using (auth.uid() = user_id);

create policy notebook_attachments_select on public.notebook_attachments for select using (auth.uid() = user_id);
create policy notebook_attachments_insert on public.notebook_attachments for insert with check (auth.uid() = user_id);
create policy notebook_attachments_update on public.notebook_attachments for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy notebook_attachments_delete on public.notebook_attachments for delete using (auth.uid() = user_id);

-- After applying: re-run `get_advisors(type: security)`, per `P2`.
