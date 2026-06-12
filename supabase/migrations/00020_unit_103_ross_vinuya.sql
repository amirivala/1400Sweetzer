-- 00020_unit_103_ross_vinuya.sql
-- Unit 103 is owned by Debbie Vinuya; her son Ross Vinuya lives there.
-- Per the board, only Ross should appear on the homeowner list
-- (310-729-0481). Collapse whatever Unit 103 currently holds — Debbie,
-- Ross, or both — into a single Ross Vinuya row.
--
-- If either of them has a registered account claiming a 103 row, the
-- linkage moves to the surviving row so the household account keeps its
-- claimed status and visibility prefs.

-- auth.uid() is null inside a migration, so residents_protect would
-- treat us as a non-admin and revert the changes. Same as 00019.
alter table residents disable trigger residents_protect;

do $$
declare
  v_target_id       uuid;
  v_claimed_profile uuid;
begin
  -- Prefer the profile on a Ross-named row if more than one row is claimed.
  select profile_id into v_claimed_profile
    from residents
   where unit_number = '103' and profile_id is not null
   order by (display_name ilike '%ross%') desc
   limit 1;

  -- Prefer an existing Ross row as the survivor.
  select id into v_target_id
    from residents
   where unit_number = '103' and display_name ilike '%ross%vinuya%'
   limit 1;

  if v_target_id is null then
    select id into v_target_id
      from residents
     where unit_number = '103'
     order by sort_order
     limit 1;
  end if;

  if v_target_id is null then
    insert into residents (unit_number, display_name, phone, occupancy_type, sort_order)
    values ('103', 'Ross Vinuya', '+13107290481', 'owner', 1)
    returning id into v_target_id;
  end if;

  -- Delete the losers first so reassigning profile_id can't trip the
  -- unique constraint.
  delete from residents
   where unit_number = '103' and id <> v_target_id;

  update residents
     set display_name   = 'Ross Vinuya',
         phone          = '+13107290481',
         occupancy_type = 'owner',
         profile_id     = v_claimed_profile,
         sort_order     = 1,
         notes          = 'Unit owned by Debbie Vinuya (Ross''s mother, 248 number); board wants only Ross listed for now.'
   where id = v_target_id;
end $$;

alter table residents enable trigger residents_protect;
