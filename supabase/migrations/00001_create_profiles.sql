-- 00001_create_profiles.sql
-- Extends auth.users with condo-specific profile data.

create type profile_role as enum ('resident', 'admin');
create type profile_status as enum ('pending', 'approved', 'removed');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  unit_number text not null,
  phone text not null,
  role profile_role not null default 'resident',
  status profile_status not null default 'pending',
  directory_visible boolean not null default true,
  email_news_optin boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profiles row when a new user signs up via Supabase Auth.
-- The frontend signup form will pass full_name / unit_number / phone via
-- the auth user_metadata payload; the trigger picks them out.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, full_name, unit_number, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'unit_number', ''),
    coalesce(new.raw_user_meta_data->>'phone', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Auto-update updated_at on every profile row update.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();
