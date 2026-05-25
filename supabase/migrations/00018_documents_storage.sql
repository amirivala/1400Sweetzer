-- 00018_documents_storage.sql
-- Private bucket for the documents library + RLS on storage.objects.
-- Approved residents can download; admins can upload/replace/delete.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false,
  52428800,  -- 50 MB ceiling; largest current file is the 5.9 MB CC&Rs
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',          -- xlsx
    'application/vnd.ms-excel',                                                   -- xls
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',    -- docx
    'image/jpeg', 'image/png'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "approved residents can read document objects"
  on storage.objects for select
  using (bucket_id = 'documents' and is_approved_resident());

create policy "admins can upload document objects"
  on storage.objects for insert
  with check (bucket_id = 'documents' and is_approved_admin());

create policy "admins can update document objects"
  on storage.objects for update
  using (bucket_id = 'documents' and is_approved_admin())
  with check (bucket_id = 'documents' and is_approved_admin());

create policy "admins can delete document objects"
  on storage.objects for delete
  using (bucket_id = 'documents' and is_approved_admin());
