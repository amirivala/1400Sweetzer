-- 00027_post_attachments_hardening.sql
-- Tightens the storage RLS introduced in 00026 after security review.
--
--   1. READ leak (critical): the object-read policy was a blanket
--      "any approved resident", so a resident could storage.list() the
--      bucket, harvest the object keys of UNPUBLISHED (draft) news
--      attachments, and createSignedUrl() them — the random-UUID key is
--      not secret once list() hands it over. Re-tie object readability to
--      a linked post_attachments row whose parent is published (or the
--      caller is admin, or it's a bulletin). Orphaned objects (no row)
--      also become unreadable as a side effect.
--   2. WRITE scope (least privilege): residents could upload objects under
--      any prefix, including news/. Restrict residents to the bulletins/
--      prefix; admins may write anywhere.

-- ── 1. Object read: mirror the table's published/admin/bulletin gating ──
drop policy if exists "read post-attachment objects" on storage.objects;
create policy "read post-attachment objects"
  on storage.objects for select
  using (
    bucket_id = 'post-attachments' and is_approved_resident() and exists (
      select 1 from post_attachments a
      where a.storage_path = storage.objects.name
        and (
          is_approved_admin()
          or a.bulletin_id is not null
          or exists (select 1 from news_posts p
                     where p.id = a.news_post_id and p.published)
        )
    )
  );

-- ── 2. Object insert: admins anywhere; residents only under bulletins/ ──
drop policy if exists "insert post-attachment objects" on storage.objects;
create policy "insert post-attachment objects"
  on storage.objects for insert
  with check (
    bucket_id = 'post-attachments' and (
      is_approved_admin()
      or (is_approved_resident() and storage.objects.name like 'bulletins/%')
    )
  );
