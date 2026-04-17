# Plan 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the foundational plumbing in place — Supabase schema with RLS, Cloudflare Pages hosting, custom domain, Resend account, and a working magic-link sign-in flow with a manually-created test admin user.

**Architecture:** Static vanilla HTML/CSS/JS hosted on Cloudflare Pages. Supabase provides auth, Postgres, and (later) Storage + Edge Functions. Resend handles transactional email (set up now, used in Plan 5). All migrations live in `supabase/migrations/` and are applied via the Supabase Dashboard's SQL Editor.

**Tech Stack:** Vanilla JS + supabase-js (CDN), Supabase Postgres + Auth, Cloudflare Pages, Cloudflare Registrar, Resend.

**Definition of done:** You can visit `https://1400sweetzer.com`, click "Sign in", enter the test admin's email, click the magic link in your inbox, and land on a placeholder home page that says "Welcome, [email]". Auth-guard correctly redirects un-signed-in users away from `/home.html`.

**What's NOT in this plan** (covered in later plans): sign-up form, admin approval UI, news/events/providers/directory pages, news email pipeline, visual polish, real content.

---

## File Structure (after Plan 1)

```
1400Website/
├── .gitignore
├── README.md                       ← bootstrap + dev instructions
├── index.html                      ← public landing
├── home.html                       ← post-login placeholder
├── auth/
│   ├── signin.html                 ← magic link request form
│   └── callback.html               ← magic link redirect handler
├── assets/
│   ├── env.js                      ← public Supabase URL + anon key
│   ├── supabase-client.js          ← initializes client
│   ├── auth-guard.js               ← redirects un-signed-in users
│   └── styles.css                  ← minimal base styles
├── supabase/
│   └── migrations/
│       ├── 00001_create_profiles.sql
│       ├── 00002_create_news_posts.sql
│       ├── 00003_create_events.sql
│       ├── 00004_create_providers.sql
│       ├── 00005_create_admin_actions.sql
│       ├── 00006_rls_policies.sql
│       └── 00007_rls_hardening.sql
└── docs/superpowers/               ← already exists
```

---

## Task 1: Initialize project structure

**Files:**
- Create: `.gitignore`, `README.md`
- Create directories: `auth/`, `assets/`, `supabase/migrations/`

- [ ] **Step 1: Create `.gitignore`**

```
# Local env / secrets (anon key is public, service role key is NOT)
supabase/.env
supabase/config.toml
.env

# OS
.DS_Store

# Editors
.vscode/
.idea/
```

- [ ] **Step 2: Create skeleton `README.md`**

```markdown
# 1400 Sweetzer Resident Portal

Private web portal for residents of 1400 Sweetzer.

See `docs/superpowers/specs/2026-04-17-1400sweetzer-resident-portal-design.md` for the full design.

## Local development

This is a static site — no build step. Open `index.html` in a browser, or serve locally with:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deployment

Pushes to `main` auto-deploy to Cloudflare Pages.

## Bootstrap (one-time)

After running migrations, manually promote the first admin in Supabase SQL Editor:

```sql
update profiles
set role = 'admin', status = 'approved'
where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
```
```

- [ ] **Step 3: Create empty directories**

```bash
mkdir -p auth assets supabase/migrations
```

- [ ] **Step 4: Commit**

```bash
git add 1400Website/.gitignore 1400Website/README.md
git commit -m "chore(1400): scaffold project skeleton"
```

---

## Task 2: Sign up for Supabase and capture credentials

**Files:**
- Create: `assets/env.js`

- [ ] **Step 1: Create Supabase project (manual, in browser)**

  1. Visit https://supabase.com/dashboard
  2. Sign up / sign in with GitHub
  3. Click "New project"
  4. Project name: `1400sweetzer`
  5. Database password: generate strong, save in your password manager
  6. Region: closest to Los Angeles (e.g., `us-west-1` or `us-east-1`)
  7. Plan: Free
  8. Wait ~2 min for provisioning

- [ ] **Step 2: Capture credentials**

  In the dashboard, go to **Project Settings → API** and copy:
  - Project URL (looks like `https://xxxxx.supabase.co`)
  - `anon` `public` API key (a long JWT — this is safe to put in browser code)
  - `service_role` key (DO NOT put in browser code — for Edge Functions only, save in password manager)

- [ ] **Step 3: Create `assets/env.js`**

```javascript
// Public Supabase config — safe to commit. The anon key is meant for browser use;
// row-level security in the database controls what callers can actually access.
window.ENV = {
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_KEY_HERE',
};
```

Replace the two placeholder strings with your actual values.

- [ ] **Step 4: Commit**

```bash
git add 1400Website/assets/env.js
git commit -m "feat(1400): add Supabase public config"
```

---

## Task 3: Write migration — `profiles` table + auth.users trigger

**Files:**
- Create: `supabase/migrations/00001_create_profiles.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add 1400Website/supabase/migrations/00001_create_profiles.sql
git commit -m "feat(1400): add profiles table and auth.users trigger"
```

---

## Task 4: Write migration — `news_posts`

**Files:**
- Create: `supabase/migrations/00002_create_news_posts.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add 1400Website/supabase/migrations/00002_create_news_posts.sql
git commit -m "feat(1400): add news_posts table"
```

---

## Task 5: Write migration — `events`

**Files:**
- Create: `supabase/migrations/00003_create_events.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00003_create_events.sql

create table events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  location text,
  start_at timestamptz not null,
  end_at timestamptz,
  created_by uuid not null references profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index events_start_at_idx on events (start_at);
```

- [ ] **Step 2: Commit**

```bash
git add 1400Website/supabase/migrations/00003_create_events.sql
git commit -m "feat(1400): add events table"
```

---

## Task 6: Write migration — `providers`

**Files:**
- Create: `supabase/migrations/00004_create_providers.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add 1400Website/supabase/migrations/00004_create_providers.sql
git commit -m "feat(1400): add providers table"
```

---

## Task 7: Write migration — `admin_actions` (audit log)

**Files:**
- Create: `supabase/migrations/00005_create_admin_actions.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add 1400Website/supabase/migrations/00005_create_admin_actions.sql
git commit -m "feat(1400): add admin_actions audit log table"
```

---

## Task 8: Write migration — RLS policies

**Files:**
- Create: `supabase/migrations/00006_rls_policies.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00006_rls_policies.sql
-- Row Level Security: who can read/write what.

-- Helper: is the current user an approved admin?
create or replace function is_approved_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and role = 'admin'
      and status = 'approved'
  );
$$;

-- Helper: is the current user any approved resident?
create or replace function is_approved_resident()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and status = 'approved'
  );
$$;

-- ─────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────
alter table profiles enable row level security;

-- Anyone authenticated can see their own profile (needed for status checks).
create policy "users can read own profile"
  on profiles for select
  using (auth.uid() = id);

-- Approved residents can read other approved residents (the directory).
create policy "approved residents can read approved profiles"
  on profiles for select
  using (is_approved_resident() and status = 'approved');

-- Users can update only their own profile, and only safe columns
-- (the trigger / migrations enforce; the policy restricts WHO).
create policy "users can update own profile"
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Admins can update any profile (for approval, role changes, removal).
create policy "admins can update any profile"
  on profiles for update
  using (is_approved_admin())
  with check (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- news_posts
-- ─────────────────────────────────────────────────────────────
alter table news_posts enable row level security;

create policy "approved residents can read published news"
  on news_posts for select
  using (is_approved_resident() and published = true);

create policy "admins can read all news"
  on news_posts for select
  using (is_approved_admin());

create policy "admins can write news"
  on news_posts for insert with check (is_approved_admin());
create policy "admins can update news"
  on news_posts for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete news"
  on news_posts for delete using (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- events
-- ─────────────────────────────────────────────────────────────
alter table events enable row level security;

create policy "approved residents can read events"
  on events for select using (is_approved_resident());

create policy "admins can write events"
  on events for insert with check (is_approved_admin());
create policy "admins can update events"
  on events for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete events"
  on events for delete using (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- providers
-- ─────────────────────────────────────────────────────────────
alter table providers enable row level security;

create policy "approved residents can read providers"
  on providers for select using (is_approved_resident());

create policy "admins can write providers"
  on providers for insert with check (is_approved_admin());
create policy "admins can update providers"
  on providers for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete providers"
  on providers for delete using (is_approved_admin());

-- ─────────────────────────────────────────────────────────────
-- admin_actions
-- ─────────────────────────────────────────────────────────────
alter table admin_actions enable row level security;

create policy "admins can read audit log"
  on admin_actions for select using (is_approved_admin());

create policy "admins can write audit log"
  on admin_actions for insert with check (is_approved_admin());
```

- [ ] **Step 2: Commit**

```bash
git add 1400Website/supabase/migrations/00006_rls_policies.sql
git commit -m "feat(1400): add Row Level Security policies"
```

---

## Task 8b: Write migration — RLS hardening (added during code review)

**Files:**
- Create: `supabase/migrations/00007_rls_hardening.sql`

This migration addresses gaps that came up in the post-Task-8 code review:
- Residents could self-promote by directly updating their own `role`/`status`
- Hidden directory rows (`directory_visible=false`) were still readable by other approved residents
- Admins could write content with someone else's id in `author_id` / `created_by` / `actor_id`
- Helper RLS functions were callable by anonymous users
- No CHECK ensured `events.end_at >= events.start_at`

The migration is committed in this batch. Just apply it after `00006` in Task 9.

---

## Task 9: Apply migrations to Supabase

**Files:** none (this is a remote-side action)

- [ ] **Step 1: Open the Supabase SQL Editor**

  In the Supabase dashboard, click **SQL Editor** in the left sidebar.

- [ ] **Step 2: Run each migration in order**

  For each file in `supabase/migrations/`, in numerical order (`00001` → `00007`):

  1. Open the file in your editor, copy the entire contents
  2. Paste into the Supabase SQL Editor
  3. Click "Run"
  4. Verify "Success. No rows returned" in the output

  If any migration errors out, fix it locally, commit the fix, and re-run.

- [ ] **Step 3: Verify all tables exist**

  In the Supabase SQL Editor, run:

  ```sql
  select table_name from information_schema.tables
  where table_schema = 'public'
  order by table_name;
  ```

  Expected output: `admin_actions`, `events`, `news_posts`, `profiles`, `providers`.

- [ ] **Step 4: Verify RLS is enabled on all five tables**

  ```sql
  select tablename, rowsecurity from pg_tables
  where schemaname = 'public' and tablename in
    ('profiles', 'news_posts', 'events', 'providers', 'admin_actions');
  ```

  Expected: `rowsecurity = true` for all five rows.

---

## Task 10: Manually create the first admin user

**Files:** none (action in Supabase dashboard)

- [ ] **Step 1: Sign up through Supabase Auth UI**

  In the Supabase dashboard, go to **Authentication → Users → Add user → Send invitation**.

  Use your real email address. Supabase will email you an invite link; click it and finish setting up the account in the popup.

- [ ] **Step 2: Verify the trigger created a profile row**

  In SQL Editor:

  ```sql
  select id, full_name, unit_number, phone, role, status
  from profiles
  where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
  ```

  Expected: one row, `role='resident'`, `status='pending'`, all text fields empty.

- [ ] **Step 3: Promote yourself to admin and approved**

  ```sql
  update profiles
  set
    role = 'admin',
    status = 'approved',
    full_name = 'Your Name',
    unit_number = 'YOUR_UNIT',
    phone = 'YOUR_PHONE'
  where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
  ```

  Re-run the SELECT from Step 2 to verify.

---

## Task 11: Verify RLS policies behave correctly

**Files:** none (test in Supabase SQL Editor)

These are quick sanity checks — not automated, but worth doing once to catch policy bugs early.

- [ ] **Step 1: Confirm RLS is on by checking the system catalog**

  In Supabase SQL Editor:

  ```sql
  select tablename, rowsecurity, count(p.policyname) as policy_count
  from pg_tables t
  left join pg_policies p
    on p.schemaname = t.schemaname and p.tablename = t.tablename
  where t.schemaname = 'public'
    and t.tablename in ('profiles', 'news_posts', 'events', 'providers', 'admin_actions')
  group by tablename, rowsecurity
  order by tablename;
  ```

  Expected: every row has `rowsecurity = true` and a non-zero `policy_count`.
  - `profiles`: 4 policies
  - `news_posts`: 5 policies
  - `events`, `providers`: 4 policies each
  - `admin_actions`: 2 policies

  If any table has 0 policies or rowsecurity is false, re-run migration `00006`.

- [ ] **Step 2: Seed a test news post (as superuser, bypasses RLS)**

  In SQL Editor — this works because the dashboard runs as `postgres`:

  ```sql
  insert into news_posts (title, body, author_id, published, email_residents, published_at)
  values (
    'Test post',
    '<p>Hello world</p>',
    (select id from profiles where role = 'admin' limit 1),
    true,
    false,
    now()
  );

  select id, title, published from news_posts;
  -- Expected: 1 row
  ```

  Leave this row in place — it'll show up in the resident feed once we build it in Plan 3.

  We'll do real end-to-end RLS verification (anon-key client gets no data, signed-in user gets only what they should) on the deployed site in Task 19.

---

## Task 12: Create the static HTML pages

**Files:**
- Create: `index.html`, `auth/signin.html`, `auth/callback.html`, `home.html`

- [ ] **Step 1: Create `index.html` (public landing)**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>1400 Sweetzer</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <main class="landing">
    <h1>1400 Sweetzer</h1>
    <p class="tagline">The resident portal.</p>
    <a class="btn btn--primary" href="/auth/signin.html">Sign in</a>
  </main>
</body>
</html>
```

- [ ] **Step 2: Create `auth/signin.html` (magic link request)**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in · 1400 Sweetzer</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <main class="auth">
    <h1>Sign in</h1>
    <form id="signinForm">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" />
      <button type="submit" class="btn btn--primary">Send magic link</button>
    </form>
    <p id="status" class="status" role="status"></p>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="/assets/env.js"></script>
  <script src="/assets/supabase-client.js"></script>
  <script>
    const form = document.getElementById('signinForm');
    const status = document.getElementById('status');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.textContent = 'Sending…';
      const email = document.getElementById('email').value.trim();
      const { error } = await window.sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${location.origin}/auth/callback.html` },
      });
      status.textContent = error
        ? `Error: ${error.message}`
        : 'Check your email for the sign-in link.';
    });
  </script>
</body>
</html>
```

- [ ] **Step 3: Create `auth/callback.html` (handles the magic-link redirect)**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signing you in…</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <main class="auth">
    <p id="status" class="status" role="status">Signing you in…</p>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="/assets/env.js"></script>
  <script src="/assets/supabase-client.js"></script>
  <script>
    // supabase-js auto-parses the URL hash and stores the session.
    // We just need to wait for it, then route based on profile status.
    (async () => {
      const status = document.getElementById('status');

      // Give supabase-js a tick to consume the URL hash.
      await new Promise((r) => setTimeout(r, 50));

      const { data: { session } } = await window.sb.auth.getSession();
      if (!session) {
        status.textContent = 'Sign-in failed. Try again.';
        setTimeout(() => (location.href = '/auth/signin.html'), 1500);
        return;
      }

      const { data: profile, error } = await window.sb
        .from('profiles')
        .select('status')
        .eq('id', session.user.id)
        .single();

      if (error || !profile) {
        // Edge case: trigger didn't run, or row was deleted.
        location.href = '/';
        return;
      }

      if (profile.status === 'approved') {
        location.href = '/home.html';
      } else if (profile.status === 'pending') {
        // pending.html doesn't exist yet (Plan 2). For now, sign them out.
        await window.sb.auth.signOut();
        status.textContent = 'Your account is pending approval.';
      } else {
        await window.sb.auth.signOut();
        status.textContent = 'Your account is no longer active.';
      }
    })();
  </script>
</body>
</html>
```

- [ ] **Step 4: Create `home.html` (placeholder, auth-gated)**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Home · 1400 Sweetzer</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <main class="home">
    <h1>1400 Sweetzer</h1>
    <p>Welcome, <span id="userEmail">…</span></p>
    <button id="signOutBtn" class="btn">Sign out</button>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="/assets/env.js"></script>
  <script src="/assets/supabase-client.js"></script>
  <script src="/assets/auth-guard.js"></script>
  <script>
    (async () => {
      const { data: { session } } = await window.sb.auth.getSession();
      if (session) {
        document.getElementById('userEmail').textContent = session.user.email;
      }
      document.getElementById('signOutBtn').addEventListener('click', async () => {
        await window.sb.auth.signOut();
        location.href = '/';
      });
    })();
  </script>
</body>
</html>
```

- [ ] **Step 5: Commit**

```bash
git add 1400Website/index.html 1400Website/home.html 1400Website/auth/
git commit -m "feat(1400): add landing, signin, callback, and home pages"
```

---

## Task 13: Add the shared JS helpers

**Files:**
- Create: `assets/supabase-client.js`, `assets/auth-guard.js`

- [ ] **Step 1: Create `assets/supabase-client.js`**

```javascript
// Initializes a single Supabase client and exposes it as window.sb.
// All pages that need DB / auth access load this script.
(() => {
  const { createClient } = window.supabase;
  window.sb = createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);
})();
```

- [ ] **Step 2: Create `assets/auth-guard.js`**

```javascript
// Redirects un-signed-in or non-approved users away from this page.
// Include AFTER supabase-client.js on any page that requires an approved session.
(async () => {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) {
    location.href = '/';
    return;
  }

  const { data: profile, error } = await window.sb
    .from('profiles')
    .select('status')
    .eq('id', session.user.id)
    .single();

  if (error || !profile || profile.status !== 'approved') {
    await window.sb.auth.signOut();
    location.href = '/';
  }
})();
```

- [ ] **Step 3: Commit**

```bash
git add 1400Website/assets/supabase-client.js 1400Website/assets/auth-guard.js
git commit -m "feat(1400): add Supabase client init and auth guard"
```

---

## Task 14: Add minimal base styles

**Files:**
- Create: `assets/styles.css`

This is intentionally barebones. Real visual polish (typography, motion, color) is Plan 6.

- [ ] **Step 1: Create `assets/styles.css`**

```css
/* Minimal base styles for Plan 1. Plan 6 will replace this with the
   real visual design (typography, color, motion, mobile bottom nav). */

:root {
  --ink: #1a1a1a;
  --bg: #fafaf7;
  --primary: #c2543a;
  --border: #e6e3dc;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.5;
}

main {
  max-width: 480px;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}

h1 {
  font-size: 2.25rem;
  margin: 0 0 0.5rem;
  letter-spacing: -0.02em;
}

.tagline { color: #666; margin: 0 0 2rem; }

label { display: block; margin-bottom: 0.25rem; font-weight: 500; }
input[type="email"] {
  width: 100%;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 1rem;
  margin-bottom: 1rem;
}

.btn {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: white;
  color: var(--ink);
  font-size: 1rem;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.1s ease;
}
.btn:active { transform: scale(0.98); }
.btn--primary {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}

.status { margin-top: 1rem; color: #555; }
```

- [ ] **Step 2: Commit**

```bash
git add 1400Website/assets/styles.css
git commit -m "feat(1400): add minimal base styles"
```

---

## Task 15: Push to GitHub (personal account `amirivala`)

**Files:** none

- [ ] **Step 1: Verify your existing `git remote -v` does NOT push to a company remote**

```bash
cd /Users/amir/WORX/AmirAlaviWorx
git remote -v
```

Confirm the remote points to your personal `amirivala` account (NOT to anything under `dopple`).

- [ ] **Step 2: Push current branch**

```bash
git push origin main
```

If you're on a different branch, push that branch instead. (The whole `1400Website/` folder lives inside the existing AmirAlaviWorx repo on `amirivala`, alongside MyWebsite.)

---

## Task 16: Set up Cloudflare Pages

**Files:** none (manual UI work)

- [ ] **Step 1: Sign up / sign in at https://dash.cloudflare.com**

- [ ] **Step 2: Create a Pages project**

  - Workers & Pages → Create → Pages → "Connect to Git"
  - Authorize Cloudflare on your `amirivala` GitHub
  - Select repo `AmirAlaviWorx`
  - Project name: `1400sweetzer`
  - Production branch: `main`
  - Framework preset: **None**
  - Build command: *(leave empty)*
  - Build output directory: `1400Website`
  - Click "Save and Deploy"

- [ ] **Step 3: Verify the site is live**

  Once deployment finishes, visit the assigned `*.pages.dev` URL (shown in the Cloudflare UI). You should see the "1400 Sweetzer" landing page.

  If 404: re-check the build output directory is `1400Website` (not the repo root).

---

## Task 17: Buy `1400sweetzer.com` and connect it

**Files:** none

- [ ] **Step 1: Register the domain via Cloudflare Registrar**

  - Cloudflare dashboard → "Domain Registration" → "Register Domains"
  - Search `1400sweetzer.com` (or your variant)
  - Buy it (~$10/year, no markup)

- [ ] **Step 2: Connect the domain to the Pages project**

  - Pages project `1400sweetzer` → "Custom domains" → "Set up a custom domain"
  - Enter `1400sweetzer.com` and `www.1400sweetzer.com`
  - Cloudflare auto-configures DNS since the domain is registered with them

- [ ] **Step 3: Verify**

  Within a few minutes, `https://1400sweetzer.com` should serve the landing page over HTTPS.

- [ ] **Step 4: Update Supabase auth redirect allowlist**

  In Supabase dashboard → Authentication → URL Configuration:
  - Site URL: `https://1400sweetzer.com`
  - Redirect URLs (add all): `https://1400sweetzer.com/auth/callback.html`, `http://localhost:8000/auth/callback.html` (for local dev)

  Without this, magic links will fail with a redirect error.

---

## Task 18: Sign up for Resend and verify the domain

**Files:** none

(We're not sending email yet — that's Plan 5 — but doing the DNS verification now lets DNS propagate while we work.)

- [ ] **Step 1: Create a Resend account at https://resend.com**

- [ ] **Step 2: Add domain `1400sweetzer.com`**

  - Domains → Add Domain → `1400sweetzer.com`
  - Resend shows DNS records (SPF, DKIM, DMARC) to add

- [ ] **Step 3: Add the DNS records in Cloudflare**

  - Cloudflare dashboard → `1400sweetzer.com` → DNS → Records
  - Add each TXT/CNAME record exactly as Resend specifies
  - Important: set the proxy status to **DNS only** (gray cloud) for these records, not proxied

- [ ] **Step 4: Verify in Resend**

  Back in Resend, click "Verify". Status should turn to "Verified" (sometimes takes 10-30 min for DNS propagation).

- [ ] **Step 5: Capture the Resend API key**

  Resend dashboard → API Keys → Create. Save in your password manager. Don't commit.

---

## Task 19: End-to-end manual test

**Files:** none

- [ ] **Step 1: Verify the deployed site loads**

  Visit `https://1400sweetzer.com`. Landing page renders with "Sign in" button.

- [ ] **Step 2: Verify sign-in flow**

  1. Click "Sign in"
  2. Enter your test admin email
  3. See "Check your email for the sign-in link"
  4. Open the email (subject: "Confirm your signup" or "Magic Link")
  5. Click the link
  6. Verify you land on `/home.html` showing `Welcome, your-email@example.com`

- [ ] **Step 3: Verify auth-guard works**

  1. Click "Sign out" on the home page
  2. Manually navigate to `https://1400sweetzer.com/home.html`
  3. Verify you're redirected back to `/` (the landing page)

- [ ] **Step 4: Verify a non-approved user is blocked**

  In Supabase SQL Editor:

  ```sql
  -- Temporarily flip your status to test the guard
  update profiles set status = 'pending'
  where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
  ```

  Sign in fresh. Verify you do NOT reach `/home.html` (you should land on the callback page showing "pending approval", then get signed out).

  Restore your access:

  ```sql
  update profiles set status = 'approved'
  where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
  ```

---

## Task 20: Final cleanup commit

**Files:**
- Modify: `README.md` if anything changed during setup

- [ ] **Step 1: Update README with anything you discovered**

  If you ran into a quirk during setup (e.g., a specific Cloudflare setting, a Resend DNS gotcha), note it in `README.md` under a "Setup notes" section.

- [ ] **Step 2: Commit anything outstanding**

```bash
cd /Users/amir/WORX/AmirAlaviWorx
git status
# Stage and commit any remaining changes:
git add 1400Website/
git commit -m "docs(1400): capture Plan 1 setup notes"
git push origin main
```

- [ ] **Step 3: Mark Plan 1 complete**

  When all tasks check off and Task 19 passes, Plan 1 is done. We move on to Plan 2 (sign-up form + admin approval flow).

---

## What you should have at the end of Plan 1

- A live site at `https://1400sweetzer.com`
- A landing page with a working sign-in button
- A working magic-link sign-in flow that lands approved users on `/home.html`
- An auth-guard that blocks unapproved users from `/home.html`
- One test admin user (yourself) with `role='admin'`, `status='approved'`
- A complete database schema with RLS enforced
- A Resend account with verified domain (ready for Plan 5)
- A GitHub repo on `amirivala` that auto-deploys on push

What you do NOT have yet (covered in later plans):
- Sign-up form for new residents (Plan 2)
- Admin pages to approve signups (Plan 2)
- News, calendar, directory, providers pages (Plan 3)
- Admin authoring (Plan 4)
- News email pipeline (Plan 5)
- Visual polish (Plan 6)
