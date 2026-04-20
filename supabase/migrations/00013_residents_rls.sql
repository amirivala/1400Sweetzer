-- 00013_residents_rls.sql
-- RLS for the residents roster plus the approve_and_link RPC.
--
-- Visibility:
--   - Admins see everything.
--   - Approved residents see rows where show_in_directory=true, plus
--     their own linked row regardless of visibility.
-- Mutations:
--   - Admins: full insert/update/delete.
--   - Approved residents: update only their own linked row, and only
--     the two privacy fields (show_in_directory, show_phone). A BEFORE
--     UPDATE trigger reverts any other column change for non-admins.

alter table residents enable row level security;

create policy "residents readable"
  on residents for select
  using (
    is_approved_admin()
    or (
      is_approved_resident()
      and (show_in_directory = true or profile_id = auth.uid())
    )
  );

create policy "admins insert residents"
  on residents for insert
  with check (is_approved_admin());

create policy "admins update residents"
  on residents for update
  using (is_approved_admin())
  with check (is_approved_admin());

create policy "residents update own linked row"
  on residents for update
  using (is_approved_resident() and profile_id = auth.uid())
  with check (is_approved_resident() and profile_id = auth.uid());

create policy "admins delete residents"
  on residents for delete
  using (is_approved_admin());

-- Non-admins can only mutate show_in_directory / show_phone on their
-- own linked row. Any other column change is silently reverted.
create or replace function residents_protect_privileged_cols()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_approved_admin() then
    new.id              := old.id;
    new.unit_number     := old.unit_number;
    new.display_name    := old.display_name;
    new.phone           := old.phone;
    new.is_board_member := old.is_board_member;
    new.occupancy_type  := old.occupancy_type;
    new.profile_id      := old.profile_id;
    new.sort_order      := old.sort_order;
    new.notes           := old.notes;
    new.created_at      := old.created_at;
  end if;
  return new;
end;
$$;

create trigger residents_protect
  before update on residents
  for each row execute function residents_protect_privileged_cols();

-- ─────────────────────────────────────────────────────────────
-- approve_and_link: atomic admin-approval RPC.
--   - Flips profile status to approved.
--   - Links an existing residents row (p_resident_id) OR creates a new
--     row from the signup's profile data (when p_resident_id is null).
--   - Overwrites the linked row's phone with the signup's phone (users
--     know their own number better than a printed list).
-- ─────────────────────────────────────────────────────────────
create or replace function approve_and_link(
  p_profile_id  uuid,
  p_resident_id uuid,
  p_phone       text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resident_id uuid;
  v_full_name   text;
  v_unit        text;
begin
  if not is_approved_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  update profiles set status = 'approved' where id = p_profile_id;

  if p_resident_id is null then
    select full_name, unit_number
      into v_full_name, v_unit
      from profiles
     where id = p_profile_id;

    insert into residents (unit_number, display_name, phone, profile_id)
    values (v_unit, v_full_name, p_phone, p_profile_id)
    returning id into v_resident_id;
  else
    -- profile_id is null guard prevents race where two admins click Approve
    -- simultaneously for different signups targeting the same roster row.
    update residents
       set profile_id = p_profile_id,
           phone      = p_phone
     where id = p_resident_id
       and profile_id is null
    returning id into v_resident_id;

    if v_resident_id is null then
      raise exception 'Resident row not found or already claimed: %', p_resident_id;
    end if;
  end if;

  return v_resident_id;
end;
$$;

revoke all on function approve_and_link(uuid, uuid, text) from public;
grant execute on function approve_and_link(uuid, uuid, text) to authenticated;
