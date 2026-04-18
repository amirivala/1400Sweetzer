-- 00008_bootstrap_protection_fix.sql
-- Fixes a bootstrap chicken-and-egg in 00007's privileged-column trigger.
--
-- Original behavior: the trigger checked `not is_approved_admin()` and
-- reverted role/status edits. But in the SQL Editor / Edge Functions /
-- service-role contexts, `auth.uid()` is NULL → `is_approved_admin()`
-- returns false → the trigger reverts the change. That made it impossible
-- to bootstrap the first admin (or do any backend admin operation).
--
-- New behavior: only revert privileged-column edits when there IS an
-- authenticated user AND that user is not an approved admin. Anonymous
-- callers are still blocked by RLS (no UPDATE policy applies to anon).
-- Backend / SQL Editor calls (auth.uid() is null) are now allowed
-- through, which is the correct trust model for those contexts.

create or replace function profiles_protect_privileged_cols()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not is_approved_admin() then
    new.role := old.role;
    new.status := old.status;
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
