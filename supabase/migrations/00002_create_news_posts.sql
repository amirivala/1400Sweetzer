-- 00002_create_news_posts.sql

create table news_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  cover_image_url text,
  author_id uuid not null references profiles(id) on delete restrict,
  published boolean not null default false,
  email_residents boolean not null default true,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create index news_posts_published_at_idx
  on news_posts (published_at desc)
  where published = true;
