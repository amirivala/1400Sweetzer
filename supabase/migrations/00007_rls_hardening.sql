-- 00007_rls_hardening.sql
-- Tightens RLS based on initial code review:
--   1. Restrict helper functions to authenticated role.
--   2. Prevent residents from self-promoting (role/status protection trigger).
--   3. Enforce directory_visible at the row level.
--   4. Prevent author_id / created_by / actor_id spoofing on inserts.
--   5. Add events.end_at >= start_at check.
--
-- Note: profiles has no INSERT policy. Rows are inserted only by the
-- handle_new_user trigger (security definer, runs as table owner). Direct
-- client INSERTs are intentionally denied by the absence of a policy.

-- ─────────────────────────────────────────────────────────────
-- 1. Helper function permissions
-- ─────────────────────────────────────────────────────────────
revoke all on function is_approved_admin() from public;
grant execute on function is_approved_admin() to authenticated;

revoke all on function is_approved_resident() from public;
grant execute on function is_approved_resident() to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 2. profiles: privileged column protection
--    Replaces the original set_updated_at trigger with a combined
--    trigger that also reverts role/status/id/created_at edits by
--    non-admins.
-- ─────────────────────────────────────────────────────────────
drop trigger if exists profiles_updated_at on profiles;

create or replace function profiles_protect_privileged_cols()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_approved_admin() then
    new.role := old.role;
    new.status := old.status;
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_protect_and_touch
  before update on profiles
  for each row execute function profiles_protect_privileged_cols();

-- ─────────────────────────────────────────────────────────────
-- 3. profiles: directory_visible enforced at row level
-- ─────────────────────────────────────────────────────────────
drop policy if exists "approved residents can read approved profiles" on profiles;

create policy "approved residents can read directory profiles"
  on profiles for select
  using (
    is_approved_resident()
    and status = 'approved'
    and directory_visible = true
  );

-- Admins always see all profiles (including residents who hid themselves
-- from the directory and pending/removed users).
create policy "admins can read all profiles"
  on profiles for select
  using (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- 4. Prevent author_id / created_by / actor_id spoofing
-- ─────────────────────────────────────────────────────────────
drop policy if exists "admins can write news" on news_posts;
create policy "admins can write news"
  on news_posts for insert
  with check (is_approved_admin() and author_id = auth.uid());

drop policy if exists "admins can write events" on events;
create policy "admins can write events"
  on events for insert
  with check (is_approved_admin() and created_by = auth.uid());

drop policy if exists "admins can write providers" on providers;
create policy "admins can write providers"
  on providers for insert
  with check (is_approved_admin() and created_by = auth.uid());

drop policy if exists "admins can write audit log" on admin_actions;
create policy "admins can write audit log"
  on admin_actions for insert
  with check (is_approved_admin() and actor_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- 5. events.end_at sanity check
-- ─────────────────────────────────────────────────────────────
alter table events
  add constraint events_end_at_after_start_at
  check (end_at is null or end_at >= start_at);
