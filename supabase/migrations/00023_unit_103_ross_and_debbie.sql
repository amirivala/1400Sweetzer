-- 00023_unit_103_ross_and_debbie.sql
-- The board reversed 00020: Unit 103 should list BOTH Ross Vinuya and his
-- mother Debbie Vinuya (the owner). 00020 had collapsed the unit to a
-- single Ross row and moved the household's claimed account onto it — but
-- that account is Debbie's, so the directory showed Ross wearing his
-- mother's "Registered" badge.
--
-- Split back into two rows: Ross (310 number, no account yet) and Debbie
-- (248 number) carrying her own account linkage.

-- auth.uid() is null inside a migration, so residents_protect would
-- treat us as a non-admin and revert the changes. Same as 00019-00022.
alter table residents disable trigger residents_protect;

do $$
declare
  v_ross_id           uuid;
  v_claimed_profile   uuid;
  v_profile_is_debbie boolean;
begin
  select id, profile_id into v_ross_id, v_claimed_profile
    from residents
   where unit_number = '103' and display_name ilike '%ross%vinuya%'
   limit 1;

  -- Whose account is actually claiming the unit?
  select p.full_name ilike '%debbie%' into v_profile_is_debbie
    from profiles p
   where p.id = v_claimed_profile;

  -- If the claimed account is Debbie's, detach it from Ross's row first
  -- (profile_id is unique) so her new row can carry it.
  if coalesce(v_profile_is_debbie, false) then
    update residents set profile_id = null where id = v_ross_id;
  end if;

  if not exists (
    select 1 from residents
     where unit_number = '103' and display_name ilike '%debbie%vinuya%'
  ) then
    insert into residents (unit_number, display_name, phone, occupancy_type, sort_order, profile_id)
    values ('103', 'Debbie Vinuya', '+12488918040', 'owner', 2,
            case when coalesce(v_profile_is_debbie, false) then v_claimed_profile else null end);
  end if;

  -- Ross stays first; the "only Ross listed" note from 00020 no longer applies.
  update residents
     set sort_order = 1,
         notes      = 'Unit owned by Debbie Vinuya (Ross''s mother); board now lists both.'
   where id = v_ross_id;
end $$;

alter table residents enable trigger residents_protect;
