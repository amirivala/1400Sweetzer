-- 00017_create_documents.sql
-- Documents library: metadata for files stored in the private 'documents' bucket.
-- Mirrors the providers RLS shape: approved residents read; admins write.

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  note text,                          -- subtitle, e.g. "Adopted May 2007"
  storage_path text not null unique,  -- object key within the 'documents' bucket
  file_name text not null,            -- original filename, used for download
  mime_type text,
  size_bytes bigint,
  sort_order int not null default 0,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_sort_idx on documents (sort_order, created_at);

-- Reuse the existing shared trigger function (also used by residents).
create trigger documents_updated_at
  before update on documents
  for each row execute function set_updated_at();

alter table documents enable row level security;

create policy "approved residents can read documents"
  on documents for select using (is_approved_resident());

create policy "admins can insert documents"
  on documents for insert with check (is_approved_admin());
create policy "admins can update documents"
  on documents for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete documents"
  on documents for delete using (is_approved_admin());
