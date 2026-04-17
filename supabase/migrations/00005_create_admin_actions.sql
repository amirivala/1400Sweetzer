-- 00005_create_admin_actions.sql
-- Lightweight audit log so multi-admin teams can see who did what.

create table admin_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references profiles(id) on delete restrict,
  action text not null,
  target_type text not null,
  target_id uuid not null,
  created_at timestamptz not null default now()
);

create index admin_actions_created_at_idx on admin_actions (created_at desc);
create index admin_actions_actor_idx on admin_actions (actor_id, created_at desc);
