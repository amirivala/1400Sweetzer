-- 00021_merge_karen_zambos_again.sql
-- 00019 collapsed Karen Zambos (401 + 405) to one "401/405" row, but when
-- she later signed up, the approval flow's "+ Create new roster entry"
-- option added a second row linked to her profile instead of claiming the
-- existing one. The 401/405 card now shows her twice: a registered row
-- and the original board row.
--
-- Keep the profile-claimed row (it carries her account linkage and
-- visibility prefs), fold the board flag into it, delete the rest.

alter table residents disable trigger residents_protect;

do $$
declare
  v_target_id uuid;
  v_was_board boolean;
begin
  select bool_or(is_board_member) into v_was_board
    from residents
   where display_name ilike 'karen%zambos';

  -- Survivor: the claimed row if there is one, else the oldest row.
  select id into v_target_id
    from residents
   where display_name ilike 'karen%zambos'
   order by (profile_id is not null) desc, created_at
   limit 1;

  if v_target_id is not null then
    delete from residents
     where display_name ilike 'karen%zambos' and id <> v_target_id;

    update residents
       set unit_number     = '401/405',
           display_name    = 'Karen Zambos',
           phone           = '+13104894305',
           is_board_member = coalesce(v_was_board, true),
           sort_order      = 1
     where id = v_target_id;
  end if;
end $$;

alter table residents enable trigger residents_protect;
