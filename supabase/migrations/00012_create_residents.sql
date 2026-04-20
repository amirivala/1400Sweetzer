-- 00012_create_residents.sql
-- The roster: source of truth for "who lives in the building."
-- Seeded once from the HOA Homeowner Contact List PDF (Rev. 4.13.2026),
-- maintained by admins thereafter. A profile claims its roster row via
-- residents.profile_id (populated during admin approval).

create type resident_occupancy as enum ('owner', 'tenant');

create table residents (
  id                uuid primary key default gen_random_uuid(),
  unit_number       text not null,
  display_name      text not null,
  phone             text,
  is_board_member   boolean not null default false,
  occupancy_type    resident_occupancy not null default 'owner',
  show_in_directory boolean not null default true,
  show_phone        boolean not null default true,
  profile_id        uuid unique references profiles(id) on delete set null,
  sort_order        int not null default 0,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index residents_unit_idx on residents (unit_number);
create index residents_profile_idx on residents (profile_id);

-- Reuse set_updated_at() from 00001_create_profiles.sql.
create trigger residents_updated_at
  before update on residents
  for each row execute function set_updated_at();
