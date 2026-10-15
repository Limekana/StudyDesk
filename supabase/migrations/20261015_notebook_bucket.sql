-- v1.18.1 (StudyDesk#153 §2) — the notebook's attachment bucket, and the two
-- constraints its table was meant to mirror.
--
-- `notebook_attachments` (20260903_notebook.sql) says it mirrors
-- `assignment_attachments`, and its files belong in a private `notebook`
-- bucket (sync.js NOTEBOOK_BUCKET). Neither half exists: there is no such
-- bucket, so an upload would fail, and the table lacks the path-ownership
-- CHECK and UNIQUE(storage_path) the attachments table has. Nothing uploads to
-- it yet and it holds 0 rows (checked 2026-10-15), so this is latent; it has
-- to be in place before notebook uploads ship.
--
-- Everything mirrors the assignment-attachments setup as it is in production:
--   - the bucket is private, 10 MiB, with the same allowed MIME types;
--   - four storage policies scoped by the first path segment being the
--     caller's id (paths are `<user_id>/<entry_id>/<file>`);
--   - CHECK (storage_path LIKE user_id || '/%'), a non-negative size, and
--     UNIQUE (storage_path).
--
-- delete-account removes each user's files from every bucket the project has
-- (userFiles.js), this one included once it exists.
--
-- NOT APPLIED. The owner applies it. Idempotent: safe to run twice.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'notebook', 'notebook', false, 10485760,
  array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip'
  ]
)
-- A `notebook` bucket made by hand in the meantime is brought to these
-- settings (private above all) rather than kept as it is.
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists studydesk_notebook_select on storage.objects;
drop policy if exists studydesk_notebook_insert on storage.objects;
drop policy if exists studydesk_notebook_update on storage.objects;
drop policy if exists studydesk_notebook_delete on storage.objects;

create policy studydesk_notebook_select on storage.objects for select
  using (bucket_id = 'notebook' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy studydesk_notebook_insert on storage.objects for insert
  with check (bucket_id = 'notebook' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy studydesk_notebook_update on storage.objects for update
  using (bucket_id = 'notebook' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'notebook' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy studydesk_notebook_delete on storage.objects for delete
  using (bucket_id = 'notebook' and (storage.foldername(name))[1] = (select auth.uid())::text);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notebook_attachments_path_is_owned'
                   and conrelid = 'public.notebook_attachments'::regclass) then
    alter table public.notebook_attachments
      add constraint notebook_attachments_path_is_owned check (storage_path like user_id::text || '/%');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notebook_attachments_size_bytes_check'
                   and conrelid = 'public.notebook_attachments'::regclass) then
    alter table public.notebook_attachments
      add constraint notebook_attachments_size_bytes_check check (size_bytes is null or size_bytes >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notebook_attachments_storage_path_key'
                   and conrelid = 'public.notebook_attachments'::regclass) then
    alter table public.notebook_attachments
      add constraint notebook_attachments_storage_path_key unique (storage_path);
  end if;
end $$;

-- Check afterwards:
--   select id, public, file_size_limit from storage.buckets where id = 'notebook';
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.notebook_attachments'::regclass and contype in ('c', 'u');
