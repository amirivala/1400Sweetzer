-- 00016_recreate_bulletins.sql
-- The bulletins table from 00009 is recorded as applied in the remote
-- migration history, but the table is missing from the live database:
-- PostgREST returns PGRST205 "Could not find the table 'public.bulletins'
-- in the schema cache" and the Bulletin page shows "Trouble loading
-- bulletins". `inspect db table-stats` confirms the relation is absent.
--
-- This migration idempotently re-establishes the bulletin board so the
-- page loads again. It is written defensively (guarded CREATE TYPE,
-- CREATE TABLE/INDEX IF NOT EXISTS, DROP-then-CREATE trigger/policies) so
-- it applies cleanly whether the schema is empty or holds partial leftovers.

-- Enum type — CREATE TYPE has no IF NOT EXISTS, so guard it.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'bulletin_category') then
    create type bulletin_category as enum (
      'For sale', 'Wanted', 'Free', 'Lost & found',
      'Recommendation', 'Info', 'Other'
    );
  end if;
end $$;

create table if not exists bulletins (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  category bulletin_category not null default 'Info',
  image_url text,                                  -- reserved for future photo uploads
  author_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bulletins_created_at_idx on bulletins (created_at desc);
create index if not exists bulletins_category_idx   on bulletins (category);

-- Reuse the set_updated_at() function defined in 00001.
drop trigger if exists bulletins_updated_at on bulletins;
create trigger bulletins_updated_at
  before update on bulletins
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────
alter table bulletins enable row level security;

drop policy if exists "approved residents can read bulletins" on bulletins;
create policy "approved residents can read bulletins"
  on bulletins for select
  using (is_approved_resident());

drop policy if exists "approved residents can write bulletins" on bulletins;
create policy "approved residents can write bulletins"
  on bulletins for insert
  with check (is_approved_resident() and author_id = auth.uid());

drop policy if exists "authors can update own bulletins" on bulletins;
create policy "authors can update own bulletins"
  on bulletins for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

drop policy if exists "authors can delete own bulletins" on bulletins;
create policy "authors can delete own bulletins"
  on bulletins for delete
  using (author_id = auth.uid());

drop policy if exists "admins can delete any bulletin" on bulletins;
create policy "admins can delete any bulletin"
  on bulletins for delete
  using (is_approved_admin());
