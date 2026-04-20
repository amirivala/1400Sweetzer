-- 00014_seed_residents.sql
-- Seed from Homeowner Contact List PDF (Rev. 4.13.2026).
-- 31 rows across 24 units. Rules:
--   - Couples sharing a phone become two rows sharing the phone:
--       Leonard & Rosemary Zir (202), Grant & Kristan Morrison (302).
--   - A person who appears in multiple units gets one row per unit:
--       Karen Zambos (401 + 405), Geoffrey Smith (403 + 404).
--   - Unit 203 tenant/owner split encoded via occupancy_type.
--   - Board members (the "*" entries) are tagged by person identity,
--     meaning both of Karen's rows and both of Geoffrey's rows are
--     is_board_member=true, not just the starred one.
--   - Phone stored as E.164. Rendered with dashes in the UI.

insert into residents
  (unit_number, display_name, phone, is_board_member, occupancy_type, sort_order)
values
  -- Floor 1
  ('101', 'Amir Alavi',       '+16784314812', false, 'owner',  1),
  ('101', 'Sona Sehat',       '+16626171928', false, 'owner',  2),
  ('102', 'Leslie Libman',    '+12137167728', false, 'owner',  1),
  ('103', 'Ross Vinuya',      '+13107290481', false, 'owner',  1),
  ('104', 'Frances Saravia',  '+13238487370', false, 'owner',  1),
  ('105', 'Josh Banayan',     '+18189702529', false, 'owner',  1),
  ('106', 'Chien Yu',         '+16268087429', false, 'owner',  1),
  ('106', 'Catherine Chen',   '+13107208429', false, 'owner',  2),

  -- Floor 2
  ('201', 'Jaimie Kourt',     '+13106913992', false, 'owner',  1),
  ('201', 'Richard Hynd',     '+13106913996', true,  'owner',  2),
  ('202', 'Leonard Zir',      '+15086557223', false, 'owner',  1),
  ('202', 'Rosemary Zir',     '+15086557223', false, 'owner',  2),
  ('203', 'Bruce Robertson',  '+18182198784', false, 'tenant', 1),
  ('203', 'Mark Scherzer',    '+13236464995', false, 'owner',  2),
  ('203', 'David Thomas',     '+12133613608', false, 'owner',  3),
  ('204', 'Craig Holzberg',   '+19178686936', false, 'owner',  1),
  ('205', 'Andrew Bidwell',   '+16198209373', false, 'owner',  1),
  ('206', 'Richard Munsey',   '+19178264777', false, 'owner',  1),

  -- Floor 3
  ('301', 'Kim Culmone',      '+13237701343', false, 'owner',  1),
  ('302', 'Grant Morrison',   '+13239635411', false, 'owner',  1),
  ('302', 'Kristan Morrison', '+13239635411', false, 'owner',  2),
  ('303', 'David Rosenberg',  '+13122131974', false, 'owner',  1),
  ('304', 'Howard Sussman',   '+12133930888', false, 'owner',  1),
  ('305', 'Farah Alidina',    '+12488953962', false, 'owner',  1),
  ('306', 'Frances Tevers',   '+13107211354', false, 'owner',  1),

  -- Floor 4
  ('401', 'Karen Zambos',     '+13104894305', true,  'owner',  1),
  ('402', 'Stan Kim',         '+13108927826', false, 'owner',  1),
  ('403', 'Geoffrey Smith',   '+12139993700', true,  'owner',  1),
  ('404', 'Geoffrey Smith',   '+12139993700', true,  'owner',  1),
  ('405', 'Karen Zambos',     '+13104894305', true,  'owner',  1),
  ('406', 'Catharine Skipp',  '+13057735801', false, 'owner',  1);
