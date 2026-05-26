-- 00019_combine_multi_unit_residents.sql
-- Karen Zambos owns 401 + 405 and Geoffrey Smith owns 403 + 404. The seed
-- gave each of them one row per unit, which showed up in the directory as
-- two cards per person. The board prefers a single combined row labeled
-- "401/405" and "403/404". An admin already manually added Karen's
-- "401/405" row without removing the originals, so Karen now has three
-- rows; this collapses both people to one row each.
--
-- Preserves any profile_id linkage so a signed-up resident's account
-- doesn't get orphaned by the collapse.

-- The BEFORE UPDATE trigger reverts non-admin column changes, and
-- auth.uid() is null inside a migration, so the trigger would treat us
-- as a non-admin. Disable it for the duration of this fix.
alter table residents disable trigger residents_protect;

do $$
declare
  v_target_id      uuid;
  v_claimed_profile uuid;
begin
  -- ── Karen Zambos: collapse 401 + 405 (+ existing 401/405) → 401/405 ──
  select profile_id into v_claimed_profile
    from residents
   where display_name = 'Karen Zambos' and profile_id is not null
   limit 1;

  -- Prefer the existing combined row if an admin already made one, so any
  -- edits they made (notes, phone, visibility) survive.
  select id into v_target_id
    from residents
   where display_name = 'Karen Zambos' and unit_number = '401/405'
   limit 1;

  if v_target_id is null then
    select id into v_target_id
      from residents
     where display_name = 'Karen Zambos'
     order by unit_number
     limit 1;
  end if;

  if v_target_id is not null then
    -- Delete the losers first so we don't trip the profile_id unique
    -- constraint when reassigning it to the survivor.
    delete from residents
     where display_name = 'Karen Zambos' and id <> v_target_id;

    update residents
       set unit_number = '401/405',
           profile_id  = v_claimed_profile,
           sort_order  = 1
     where id = v_target_id;
  end if;

  -- ── Geoffrey Smith: collapse 403 + 404 → 403/404 ──
  v_claimed_profile := null;
  v_target_id := null;

  select profile_id into v_claimed_profile
    from residents
   where display_name = 'Geoffrey Smith' and profile_id is not null
   limit 1;

  select id into v_target_id
    from residents
   where display_name = 'Geoffrey Smith' and unit_number = '403/404'
   limit 1;

  if v_target_id is null then
    select id into v_target_id
      from residents
     where display_name = 'Geoffrey Smith'
     order by unit_number
     limit 1;
  end if;

  if v_target_id is not null then
    delete from residents
     where display_name = 'Geoffrey Smith' and id <> v_target_id;

    update residents
       set unit_number = '403/404',
           profile_id  = v_claimed_profile,
           sort_order  = 1
     where id = v_target_id;
  end if;
end $$;

alter table residents enable trigger residents_protect;
