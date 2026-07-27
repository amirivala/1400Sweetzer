-- 00028_news_email_audience.sql
-- Lets the board scope a resident-news email to homeowners only.
--
-- Some notices are owner business (assessments, earthquake insurance
-- premiums, budgets, votes) and shouldn't land in a tenant's inbox. The
-- roster already knows who is an owner and who is a tenant
-- (residents.occupancy_type), and every approved profile is linked to its
-- roster row by approve_and_link, so the audience is derivable rather than
-- hand-maintained: a tenant moving in or a unit changing hands needs no
-- edits here.
--
-- 'all'    — every approved, opted-in resident (previous behavior, default)
-- 'owners' — only those whose linked roster row is occupancy_type='owner'

create type news_email_audience as enum ('all', 'owners');

alter table public.news_posts
  add column if not exists email_audience news_email_audience not null default 'all';

comment on column public.news_posts.email_audience is
  'Who the resident-news email goes to: all opted-in residents, or homeowners only (tenants excluded). Read by send_news_email at send time.';

-- Recipient counts for the news editor, so an admin sees the size of each
-- audience before publishing — and would notice if a number looked wrong.
-- Security definer because it aggregates across every profile and roster
-- row; the admin check inside keeps that from leaking to residents.
--
-- 'unlinked' counts opted-in profiles with no roster row. That should stay
-- zero (approval always links or creates one). If it ever isn't, those
-- people are NOT in the owners-only audience — ownership can't be
-- confirmed for them — so the editor surfaces the number instead of
-- silently dropping them.
create or replace function public.news_recipient_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not is_approved_admin() then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
           'all',      count(*),
           'owners',   count(*) filter (where r.occupancy_type = 'owner'),
           'tenants',  count(*) filter (where r.occupancy_type = 'tenant'),
           'unlinked', count(*) filter (where r.id is null)
         )
    into result
    from profiles p
    left join residents r on r.profile_id = p.id
   where p.status = 'approved'
     and p.email_news_optin;

  return result;
end;
$$;

revoke execute on function public.news_recipient_counts() from public, anon;
grant   execute on function public.news_recipient_counts() to authenticated;
