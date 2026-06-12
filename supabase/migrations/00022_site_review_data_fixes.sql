-- 00022_site_review_data_fixes.sql
-- Data fixes from the 2026-06-12 full-site review:
--   1. Amir Alavi's Unit 101 roster row was never linked to his account,
--      so the directory shows no "Registered" badge and his account-page
--      visibility toggles stay disabled.
--   2. Provider "Nathan Clarke— Madison Electric" lost the space before
--      the dash in a manual edit (the seed had "Clarken — "; the newer
--      surname is kept, only the spacing is restored).
--   3. Two profile names were saved with lowercase surnames.

-- residents_protect reverts privileged-column changes (including
-- profile_id) when there's no admin auth context, which is the case in a
-- migration — disable it around the link, as 00021 did.
alter table residents disable trigger residents_protect;

update residents r
   set profile_id = u.id
  from auth.users u
 where u.email = 'amirivala@me.com'
   and r.display_name = 'Amir Alavi'
   and r.unit_number = '101'
   and r.profile_id is null;

alter table residents enable trigger residents_protect;

update providers
   set name = 'Nathan Clarke — Madison Electric'
 where name = 'Nathan Clarke— Madison Electric';

update profiles
   set full_name = 'Sona Sehat'
 where full_name = 'Sona sehat';

update profiles
   set full_name = 'Debbie Vinuya'
 where full_name = 'Debbie vinuya';
