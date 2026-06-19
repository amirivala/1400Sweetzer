-- 00024_news_email_status.sql
-- Records the outcome of the resident-news email for each post, so a
-- publish can no longer silently go out with no email and admins can see
-- exactly what was sent (and re-send on failure).

alter table public.news_posts
  add column if not exists email_sent_at    timestamptz,
  add column if not exists email_sent_count integer,
  add column if not exists email_send_error text;

comment on column public.news_posts.email_sent_at is
  'When the resident-news email for this post was sent (null = never). Idempotency key for the send trigger.';
comment on column public.news_posts.email_sent_count is
  'Number of recipients on the most recent successful send.';
comment on column public.news_posts.email_send_error is
  'Last send failure reason, if any (null when the last attempt succeeded).';
