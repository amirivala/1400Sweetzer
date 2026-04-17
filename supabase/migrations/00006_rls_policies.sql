-- 00006_rls_policies.sql
-- Row Level Security: who can read/write what.

-- Helper: is the current user an approved admin?
create or replace function is_approved_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and role = 'admin'
      and status = 'approved'
  );
$$;

-- Helper: is the current user any approved resident?
create or replace function is_approved_resident()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and status = 'approved'
  );
$$;

-- ─────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────
alter table profiles enable row level security;

-- Anyone authenticated can see their own profile (needed for status checks).
create policy "users can read own profile"
  on profiles for select
  using (auth.uid() = id);

-- Approved residents can read other approved residents (the directory).
create policy "approved residents can read approved profiles"
  on profiles for select
  using (is_approved_resident() and status = 'approved');

-- Users can update only their own profile, and only safe columns
-- (the trigger / migrations enforce; the policy restricts WHO).
create policy "users can update own profile"
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Admins can update any profile (for approval, role changes, removal).
create policy "admins can update any profile"
  on profiles for update
  using (is_approved_admin())
  with check (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- news_posts
-- ─────────────────────────────────────────────────────────────
alter table news_posts enable row level security;

create policy "approved residents can read published news"
  on news_posts for select
  using (is_approved_resident() and published = true);

create policy "admins can read all news"
  on news_posts for select
  using (is_approved_admin());

create policy "admins can write news"
  on news_posts for insert with check (is_approved_admin());
create policy "admins can update news"
  on news_posts for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete news"
  on news_posts for delete using (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- events
-- ─────────────────────────────────────────────────────────────
alter table events enable row level security;

create policy "approved residents can read events"
  on events for select using (is_approved_resident());

create policy "admins can write events"
  on events for insert with check (is_approved_admin());
create policy "admins can update events"
  on events for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete events"
  on events for delete using (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- providers
-- ─────────────────────────────────────────────────────────────
alter table providers enable row level security;

create policy "approved residents can read providers"
  on providers for select using (is_approved_resident());

create policy "admins can write providers"
  on providers for insert with check (is_approved_admin());
create policy "admins can update providers"
  on providers for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete providers"
  on providers for delete using (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- admin_actions
-- ─────────────────────────────────────────────────────────────
alter table admin_actions enable row level security;

create policy "admins can read audit log"
  on admin_actions for select using (is_approved_admin());

create policy "admins can write audit log"
  on admin_actions for insert with check (is_approved_admin());
