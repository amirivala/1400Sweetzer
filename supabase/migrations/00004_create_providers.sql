-- 00004_create_providers.sql

create type provider_category as enum (
  'Plumbing', 'Electrical', 'HVAC', 'Locksmith', 'Cleaning', 'Other'
);

create table providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category provider_category not null,
  phone text not null,
  email text,
  notes text,
  created_by uuid not null references profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index providers_category_idx on providers (category);
