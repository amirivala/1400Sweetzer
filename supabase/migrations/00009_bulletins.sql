-- 00009_bulletins.sql
-- Resident bulletin board: a digital version of the lobby's notice board.
-- Any approved resident can post; the author (or any admin) can delete.

create type bulletin_category as enum (
  'For sale', 'Wanted', 'Free', 'Lost & found',
  'Recommendation', 'Info', 'Other'
);

create table bulletins (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  category bulletin_category not null default 'Info',
  image_url text,                                  -- reserved for future photo uploads
  author_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bulletins_created_at_idx on bulletins (created_at desc);
create index bulletins_category_idx   on bulletins (category);

-- Reuse the set_updated_at() function defined in 00001.
create trigger bulletins_updated_at
  before update on bulletins
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────
alter table bulletins enable row level security;

create policy "approved residents can read bulletins"
  on bulletins for select
  using (is_approved_resident());

create policy "approved residents can write bulletins"
  on bulletins for insert
  with check (is_approved_resident() and author_id = auth.uid());

create policy "authors can update own bulletins"
  on bulletins for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy "authors can delete own bulletins"
  on bulletins for delete
  using (author_id = auth.uid());

create policy "admins can delete any bulletin"
  on bulletins for delete
  using (is_approved_admin());
