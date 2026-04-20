-- 00015_backfill_news_published_at.sql
-- One-off repair: earlier versions of /admin/news-edit.html had a bug
-- where re-publishing an already-published post in the same session
-- could produce a new row with published=true and published_at=null
-- (the closure variable tracking the post id wasn't updated after the
-- initial insert, so the second save inserted a duplicate row, and the
-- stamp was skipped because isPublished had already been set true in
-- memory). Those rows render as "Dec 31, 1969" on /news.html.
--
-- The editor has been fixed, but any already-broken rows need their
-- published_at set to something reasonable. created_at is the closest
-- honest approximation of when publication happened.

update news_posts
   set published_at = created_at
 where published = true
   and published_at is null;
