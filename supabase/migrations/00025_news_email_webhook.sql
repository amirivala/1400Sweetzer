-- 00025_news_email_webhook.sql
-- Server-side guarantee that a published post with the email toggle on gets
-- emailed exactly once. Replaces the old best-effort, browser-fired send.
-- The shared secret is read from Vault at runtime so it never lives in git.

create extension if not exists pg_net with schema extensions;

create or replace function public.tg_news_email_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_secret text;
begin
  if new.published and new.email_residents and new.email_sent_at is null then
    select decrypted_secret into v_secret
      from vault.decrypted_secrets
      where name = 'news_webhook_secret'
      limit 1;

    perform net.http_post(
      url     := 'https://nvazngprbjccclzmgphg.supabase.co/functions/v1/send_news_email',
      headers := jsonb_build_object(
                   'Content-Type',    'application/json',
                   'X-Webhook-Secret', coalesce(v_secret, '')
                 ),
      body    := jsonb_build_object('post_id', new.id::text),
      timeout_milliseconds := 8000
    );
  end if;
  return new;
end;
$$;

drop trigger if exists news_email_on_publish on public.news_posts;
create trigger news_email_on_publish
  after insert or update on public.news_posts
  for each row execute function public.tg_news_email_notify();
