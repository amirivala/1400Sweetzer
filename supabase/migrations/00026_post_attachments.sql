-- 00026_post_attachments.sql
-- File attachments for posts. One row per uploaded file, belonging to EITHER
-- a news post (admin-authored) OR a bulletin (resident-authored). Files live
-- in the private 'post-attachments' storage bucket; this table holds the
-- metadata + the object key, mirroring the 'documents' library pattern
-- (00017 / 00018).
--
-- Visibility follows the parent:
--   • news attachments  → readable by approved residents once the post is
--                         published (admins always); writable by admins only.
--   • bulletin attachments → readable by approved residents (bulletins are);
--                         writable by the bulletin's author.

create table if not exists post_attachments (
  id uuid primary key default gen_random_uuid(),
  news_post_id uuid references news_posts(id) on delete cascade,
  bulletin_id  uuid references bulletins(id)  on delete cascade,
  storage_path text not null unique,   -- object key within 'post-attachments'
  file_name    text not null,          -- original filename, used for download
  mime_type    text,
  size_bytes   bigint,
  sort_order   int not null default 0,
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  -- Exactly one parent. Polymorphic-by-nullable-FK keeps real FKs + cascade
  -- delete on both sides while guaranteeing an attachment can't be orphaned
  -- or double-owned.
  constraint post_attachments_one_parent
    check (num_nonnulls(news_post_id, bulletin_id) = 1)
);

create index if not exists post_attachments_news_idx
  on post_attachments (news_post_id, sort_order, created_at)
  where news_post_id is not null;
create index if not exists post_attachments_bulletin_idx
  on post_attachments (bulletin_id, sort_order, created_at)
  where bulletin_id is not null;

alter table post_attachments enable row level security;

-- READ: approved residents. News attachments only once the post is published
-- (admins see drafts too); bulletin attachments are visible like bulletins.
drop policy if exists "read post attachments" on post_attachments;
create policy "read post attachments"
  on post_attachments for select
  using (
    is_approved_resident() and (
      (news_post_id is not null and (
         is_approved_admin()
         or exists (select 1 from news_posts p
                    where p.id = news_post_id and p.published)))
      or
      (bulletin_id is not null)
    )
  );

-- INSERT: the uploader stamps created_by = themselves, and may only attach to
-- a post they're allowed to write — admins for news, the author for a bulletin.
drop policy if exists "insert post attachments" on post_attachments;
create policy "insert post attachments"
  on post_attachments for insert
  with check (
    created_by = auth.uid() and (
      (news_post_id is not null and is_approved_admin())
      or
      (bulletin_id is not null and is_approved_resident()
       and exists (select 1 from bulletins b
                   where b.id = bulletin_id and b.author_id = auth.uid()))
    )
  );

-- UPDATE / DELETE: an admin, or whoever uploaded the file.
drop policy if exists "update post attachments" on post_attachments;
create policy "update post attachments"
  on post_attachments for update
  using (is_approved_admin() or created_by = auth.uid())
  with check (is_approved_admin() or created_by = auth.uid());

drop policy if exists "delete post attachments" on post_attachments;
create policy "delete post attachments"
  on post_attachments for delete
  using (is_approved_admin() or created_by = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- Storage bucket — private, mirrors the 'documents' bucket (00018).
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'post-attachments', 'post-attachments', false,
  52428800,  -- 50 MB ceiling, same as documents
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

-- Object-level RLS on the bucket. Reads: any approved resident (the table
-- above gates *which* attachments get surfaced). Writes: any approved
-- resident may upload (admins for news, authors for bulletins — both are
-- approved residents); but only the object's owner or an admin may modify or
-- remove it, so a resident can't delete another neighbor's file.
drop policy if exists "read post-attachment objects" on storage.objects;
create policy "read post-attachment objects"
  on storage.objects for select
  using (bucket_id = 'post-attachments' and is_approved_resident());

drop policy if exists "insert post-attachment objects" on storage.objects;
create policy "insert post-attachment objects"
  on storage.objects for insert
  with check (bucket_id = 'post-attachments' and is_approved_resident());

drop policy if exists "update post-attachment objects" on storage.objects;
create policy "update post-attachment objects"
  on storage.objects for update
  using (bucket_id = 'post-attachments' and (is_approved_admin() or owner = auth.uid()))
  with check (bucket_id = 'post-attachments' and (is_approved_admin() or owner = auth.uid()));

drop policy if exists "delete post-attachment objects" on storage.objects;
create policy "delete post-attachment objects"
  on storage.objects for delete
  using (bucket_id = 'post-attachments' and (is_approved_admin() or owner = auth.uid()));
