# Directory + Resident Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current signup-based directory with a unit-grouped roster seeded from the HOA homeowner list, with signup→roster linking during admin approval and per-person privacy toggles.

**Architecture:** New `residents` table as source of truth, seeded from `Homeowners List 2.1.2026.pdf` (31 rows across 24 units). `profiles.id ← residents.profile_id` links a signed-up user to their roster row. A new `approve_and_link` Postgres RPC atomically approves a profile and links/creates its roster row. Directory, account, and admin pages read/write `residents` instead of (or in addition to) `profiles`.

**Tech Stack:** Supabase Postgres + RLS, Supabase Auth, static HTML/vanilla JS (no build step), Resend for email. No test framework in repo — verification is via SQL queries and manual browser walkthrough.

**Spec:** `docs/superpowers/specs/2026-04-20-directory-roster-design.md` (commit `f8c74de`).

---

## File map

**New:**
- `supabase/migrations/00012_create_residents.sql` — table, enum, indexes, updated_at trigger.
- `supabase/migrations/00013_residents_rls.sql` — RLS policies + privileged-column protection trigger + `approve_and_link` RPC.
- `supabase/migrations/00014_seed_residents.sql` — 31 rows from the PDF.
- `admin/roster.html` — roster CRUD UI.

**Modified:**
- `directory.html` — read from `residents`, group by unit, render tags.
- `account.html` — add two opt-out toggles writing to `residents`.
- `admin/residents.html` — pending signups show candidate roster rows + "Approve & Link" button.

**Unchanged:**
- `profiles` schema.
- `signup.html`, `auth/*`, `assets/*.js` helpers, `vercel.json`.
- Existing edge functions (`send_welcome_email`, `admin_delete_user`, `notify_admin_of_signup`, `send_news_email`).

---

## Task 1: Create the `residents` table

**Files:**
- Create: `supabase/migrations/00012_create_residents.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/00012_create_residents.sql
git commit -m "DB: create residents roster table"
```

---

## Task 2: RLS policies + `approve_and_link` RPC

**Files:**
- Create: `supabase/migrations/00013_residents_rls.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00013_residents_rls.sql
-- RLS for the residents roster plus the approve_and_link RPC.
--
-- Visibility:
--   - Admins see everything.
--   - Approved residents see rows where show_in_directory=true, plus
--     their own linked row regardless of visibility.
-- Mutations:
--   - Admins: full insert/update/delete.
--   - Approved residents: update only their own linked row, and only
--     the two privacy fields (show_in_directory, show_phone). A BEFORE
--     UPDATE trigger reverts any other column change for non-admins.

alter table residents enable row level security;

create policy "residents readable"
  on residents for select
  using (
    is_approved_admin()
    or (
      is_approved_resident()
      and (show_in_directory = true or profile_id = auth.uid())
    )
  );

create policy "admins insert residents"
  on residents for insert
  with check (is_approved_admin());

create policy "admins update residents"
  on residents for update
  using (is_approved_admin())
  with check (is_approved_admin());

create policy "residents update own linked row"
  on residents for update
  using (is_approved_resident() and profile_id = auth.uid())
  with check (is_approved_resident() and profile_id = auth.uid());

create policy "admins delete residents"
  on residents for delete
  using (is_approved_admin());

-- Non-admins can only mutate show_in_directory / show_phone on their
-- own linked row. Any other column change is silently reverted.
create or replace function residents_protect_privileged_cols()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_approved_admin() then
    new.id              := old.id;
    new.unit_number     := old.unit_number;
    new.display_name    := old.display_name;
    new.phone           := old.phone;
    new.is_board_member := old.is_board_member;
    new.occupancy_type  := old.occupancy_type;
    new.profile_id      := old.profile_id;
    new.sort_order      := old.sort_order;
    new.notes           := old.notes;
    new.created_at      := old.created_at;
  end if;
  return new;
end;
$$;

create trigger residents_protect
  before update on residents
  for each row execute function residents_protect_privileged_cols();

-- ─────────────────────────────────────────────────────────────
-- approve_and_link: atomic admin-approval RPC.
--   - Flips profile status to approved.
--   - Links an existing residents row (p_resident_id) OR creates a new
--     row from the signup's profile data (when p_resident_id is null).
--   - Overwrites the linked row's phone with the signup's phone (users
--     know their own number better than a printed list).
-- ─────────────────────────────────────────────────────────────
create or replace function approve_and_link(
  p_profile_id  uuid,
  p_resident_id uuid,
  p_phone       text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resident_id uuid;
  v_full_name   text;
  v_unit        text;
begin
  if not is_approved_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  update profiles set status = 'approved' where id = p_profile_id;

  if p_resident_id is null then
    select full_name, unit_number
      into v_full_name, v_unit
      from profiles
     where id = p_profile_id;

    insert into residents (unit_number, display_name, phone, profile_id)
    values (v_unit, v_full_name, p_phone, p_profile_id)
    returning id into v_resident_id;
  else
    update residents
       set profile_id = p_profile_id,
           phone      = p_phone
     where id = p_resident_id
    returning id into v_resident_id;

    if v_resident_id is null then
      raise exception 'Resident row not found: %', p_resident_id;
    end if;
  end if;

  return v_resident_id;
end;
$$;

revoke all on function approve_and_link(uuid, uuid, text) from public;
grant execute on function approve_and_link(uuid, uuid, text) to authenticated;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/00013_residents_rls.sql
git commit -m "DB: RLS + approve_and_link RPC for residents"
```

---

## Task 3: Seed the 31 rows from the PDF

**Files:**
- Create: `supabase/migrations/00014_seed_residents.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/00014_seed_residents.sql
git commit -m "DB: seed residents roster from HOA PDF"
```

---

## Task 4: Apply migrations and verify

Applied via whichever mechanism the project uses — this repo uses Supabase hosted, so migrations are pushed via `supabase db push` from the Supabase CLI or pasted into the Supabase Studio SQL Editor. If `supabase` CLI is linked to the project already, prefer CLI. Otherwise fall back to Studio.

- [ ] **Step 1: Push migrations**

```bash
supabase db push
```

Expected output: mentions applying `00012_create_residents`, `00013_residents_rls`, `00014_seed_residents` with no errors. If CLI isn't linked, open each migration file and run its contents in the Supabase Studio SQL Editor in order.

- [ ] **Step 2: Verify row count and shape**

Run in Supabase Studio SQL Editor (or `psql` against the project):

```sql
select count(*) from residents;
-- Expected: 31

select unit_number, count(*)
from residents
group by unit_number
order by unit_number;
-- Expected: 106=2, 201=2, 202=2, 203=3, 302=2; everything else=1. 24 units total.

select display_name, unit_number
from residents
where is_board_member = true
order by display_name, unit_number;
-- Expected 5 rows:
--   Geoffrey Smith | 403
--   Geoffrey Smith | 404
--   Karen Zambos   | 401
--   Karen Zambos   | 405
--   Richard Hynd   | 201

select display_name, occupancy_type
from residents
where unit_number = '203'
order by sort_order;
-- Expected:
--   Bruce Robertson | tenant
--   Mark Scherzer   | owner
--   David Thomas    | owner
```

- [ ] **Step 3: Verify RLS behavior**

Still in the SQL Editor, impersonate different roles. Supabase Studio runs as `postgres` (bypasses RLS), so switch contexts explicitly:

```sql
-- As the JWT for an approved resident (replace <UUID> with an existing
-- approved non-admin profile id). RLS should hide no rows (all 31 visible
-- to any approved resident by default).
set local role authenticated;
set local "request.jwt.claims" to '{"sub":"<UUID>","role":"authenticated"}';
select count(*) from residents;
-- Expected: 31

-- Flip one row to hidden and confirm it drops out for a non-owner.
reset role;
update residents set show_in_directory = false
  where unit_number = '305'; -- Farah

set local role authenticated;
set local "request.jwt.claims" to '{"sub":"<UUID>","role":"authenticated"}';
select count(*) from residents where unit_number = '305';
-- Expected: 0 (hidden from this non-owner approved resident)

-- Clean up.
reset role;
update residents set show_in_directory = true where unit_number = '305';
```

Expected: counts line up.

- [ ] **Step 4: Commit if any fix-ups needed**

If a row is wrong in the seed, fix it in `00014_seed_residents.sql` and re-run only that migration (or write a patch-up migration `00015_fix_seed.sql` if you've already pushed to prod). Otherwise no commit here.

---

## Task 5: Directory page — read from `residents`, group by unit, tags

**Files:**
- Modify: `directory.html`

- [ ] **Step 1: Replace the page contents**

Rewrite the file in full (the existing file is a single page with inline script):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0c0a09" />
  <title>Directory · Sunset Penthouse</title>

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,300..700,30..100;1,9..144,300..700,30..100&family=Geist+Mono:wght@400;500&family=Geist:wght@300;400;500;600&display=swap" />
  <link rel="stylesheet" href="/assets/styles.css?v=8" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head>
<body class="page">

  <main class="page__container">
    <header class="page-header rise delay-1">
      <span class="page-header__kicker">Directory</span>
      <h1 class="page-header__title">Your neighbors.</h1>
      <p class="page-header__sub">
        Every unit in the building. Once you're approved, your phone
        shows here by default &mdash; you can hide it from your
        <a href="/account.html" style="color: var(--terracotta); text-decoration: underline;">account</a>,
        or email <a href="mailto:admin@1400nsweetzer.com" style="color: var(--terracotta); text-decoration: underline;">admin@1400nsweetzer.com</a> if you're not signed up yet.
      </p>
    </header>

    <section id="dirGrid" aria-live="polite">
      <div class="empty">
        <div class="empty__title">Loading…</div>
      </div>
    </section>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="/assets/env.js"></script>
  <script src="/assets/supabase-client.js"></script>
  <script src="/assets/auth-guard.js"></script>
  <script src="/assets/page-shell.js?v=7"></script>
  <script src="/assets/dom.js"></script>
  <script>
    (async () => {
      const grid = document.getElementById('dirGrid');
      const { data: { session } } = await window.sb.auth.getSession();
      if (!session) return;
      const meId = session.user.id;

      // Residents + linked profile (for Admin tag).
      const { data: rows, error } = await window.sb
        .from('residents')
        .select('id, unit_number, display_name, phone, is_board_member, occupancy_type, show_in_directory, show_phone, profile_id, sort_order, profile:profiles!residents_profile_id_fkey(role)')
        .order('unit_number', { ascending: true })
        .order('sort_order', { ascending: true });

      if (error) {
        mount(grid,
          el('div', { class: 'empty' },
            el('div', { class: 'empty__title', text: 'Trouble loading directory' }),
            el('p', { class: 'empty__sub', text: error.message }),
          ));
        return;
      }

      // RLS already filters for us, but "me" is always visible even if hidden.
      const visible = (rows || []).filter((r) => r.show_in_directory || r.profile_id === meId);

      if (visible.length === 0) {
        mount(grid,
          el('div', { class: 'empty' },
            el('div', { class: 'empty__title', text: 'No neighbors listed yet' }),
            el('p', { class: 'empty__sub', text: 'The roster will appear here once it\u2019s seeded.' }),
          ));
        return;
      }

      grid.className = 'dir-grid';

      const fmtPhone = (p) => {
        if (!p) return null;
        const d = String(p).replace(/[^\d]/g, '');
        const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
        if (ten.length !== 10) return p;
        return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
      };

      const phoneIcon = () => {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z');
        svg.appendChild(p);
        return svg;
      };

      // Group rows by unit preserving order.
      const unitMap = new Map();
      for (const r of visible) {
        if (!unitMap.has(r.unit_number)) unitMap.set(r.unit_number, []);
        unitMap.get(r.unit_number).push(r);
      }

      const renderTags = (r) => {
        const tags = [];
        if (r.is_board_member) tags.push(el('span', { class: 'dir-tag dir-tag--board', text: 'Board' }));
        if (r.occupancy_type === 'tenant') tags.push(el('span', { class: 'dir-tag dir-tag--tenant', text: 'Tenant' }));
        if (r.profile && r.profile.role === 'admin') tags.push(el('span', { class: 'dir-tag dir-tag--admin', text: 'Admin' }));
        if (r.profile_id) tags.push(el('span', { class: 'dir-tag dir-tag--registered', text: 'Registered' }));
        if (r.profile_id === meId) tags.push(el('span', { class: 'dir-card__you', text: 'That\u2019s you' }));
        return tags;
      };

      const cards = [];
      let idx = 0;
      for (const [unit, people] of unitMap) {
        const rows = people.map((r) => {
          const phoneShown = r.phone && r.show_phone;
          const phoneFmt = phoneShown ? fmtPhone(r.phone) : null;
          const phoneHref = phoneShown ? 'tel:' + String(r.phone).replace(/[^+\d]/g, '') : null;
          return el('div', { class: 'dir-person' },
            el('div', { class: 'dir-person__name' },
              el('span', { text: r.display_name || 'Unnamed resident' }),
              ...renderTags(r),
            ),
            phoneShown
              ? el('a', { class: 'dir-card__phone', href: phoneHref }, phoneIcon(), phoneFmt)
              : null,
          );
        });
        cards.push(el('article', {
            class: 'card dir-card liquid-glass rise',
            style: { animationDelay: `${0.10 + idx * 0.05}s` },
          },
          el('div', { class: 'dir-card__unit', text: unit }),
          ...rows,
        ));
        idx += 1;
      }

      mount(grid, ...cards);
    })();
  </script>
</body>
</html>
```

Notes:
- The PostgREST join `profile:profiles!residents_profile_id_fkey(role)` relies on the FK name Postgres gives `residents.profile_id`; if PostgREST complains about the relationship name, replace with `profile:profiles(role)` (single FK between the tables → unambiguous).
- The phone-formatting helper treats `+1XXXXXXXXXX` as the canonical stored form and falls back to showing the raw value if it can't parse.

- [ ] **Step 2: Add tag styles to `assets/styles.css`**

Append to the end of the file:

```css
/* Directory tag chips */
.dir-tag {
  display: inline-block;
  padding: 2px 8px;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  vertical-align: middle;
  line-height: 1.6;
}
.dir-tag--board      { background: rgba(230, 145, 90, 0.15); color: var(--terracotta, #c25d2a); }
.dir-tag--tenant     { background: rgba(180, 180, 180, 0.18); color: #8a8a8a; }
.dir-tag--admin      { background: rgba(90, 130, 230, 0.15); color: #4a6dd8; }
.dir-tag--registered { background: rgba(120, 120, 120, 0.1); color: #999; font-weight: 400; }

/* Multiple-people-per-unit card layout */
.dir-person {
  padding-top: 10px;
  margin-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.dir-person:first-of-type {
  padding-top: 0;
  margin-top: 0;
  border-top: none;
}
.dir-person__name {
  font-weight: 500;
  font-size: 15px;
  margin-bottom: 4px;
}
```

Bump the cache-busting query string on every `styles.css` reference from `?v=7` to `?v=8`:

- In `directory.html`, `account.html`, `admin/residents.html`, `admin/roster.html` (created later), plus any other HTML files that reference `styles.css`. Find them with: `grep -rln 'styles.css?v=' --include='*.html' .`

- [ ] **Step 3: Manual verification**

Run the site locally (or deploy to Vercel preview). Sign in as yourself (Amir, admin). Visit `/directory.html`.

Expected:
- One card per unit (101 through 406), sorted ascending.
- Unit 101 card contains both "Amir Alavi" and "Sona Sehat".
- Unit 203 card shows Bruce Robertson with a `Tenant` tag, plus Mark and David without one.
- Unit 401 card shows Karen Zambos with `Board` tag.
- Unit 202 card shows Leonard Zir and Rosemary Zir, both with the same phone.
- No one has a `Registered` tag yet (no claims have happened).

- [ ] **Step 4: Commit**

```bash
git add directory.html assets/styles.css
# Plus any HTML files touched for the cache-bust
git commit -m "Directory: read from residents roster, group by unit, show tags"
```

---

## Task 6: Admin approval page — candidate roster + Approve & Link

**Files:**
- Modify: `admin/residents.html`

- [ ] **Step 1: Extend the load query**

In the `load` function, change the `profiles` query to also fetch linked resident and candidate matches.

Replace the existing query block (currently `const { data: raw, error } = await window.sb.from('profiles')...`) with:

```javascript
const { data: raw, error } = await window.sb
  .from('profiles')
  .select('id, full_name, unit_number, phone, role, status, created_at')
  .neq('status', 'removed')
  .order('status', { ascending: true })
  .order('unit_number', { ascending: true });

if (error) {
  mount(list,
    el('div', { class: 'empty' },
      el('div', { class: 'empty__title', text: 'Trouble loading residents' }),
      el('p', { class: 'empty__sub', text: error.message }),
    ));
  return;
}

// Load candidate roster rows for pending signups in one batch.
const pendingUnits = Array.from(new Set(
  (raw || []).filter((r) => r.status === 'pending').map((r) => r.unit_number).filter(Boolean),
));
let candidatesByUnit = new Map();
if (pendingUnits.length > 0) {
  const { data: cands, error: cErr } = await window.sb
    .from('residents')
    .select('id, unit_number, display_name, phone, profile_id')
    .in('unit_number', pendingUnits)
    .is('profile_id', null)
    .order('sort_order', { ascending: true });
  if (cErr) { console.error('residents candidates load failed', cErr); }
  (cands || []).forEach((c) => {
    if (!candidatesByUnit.has(c.unit_number)) candidatesByUnit.set(c.unit_number, []);
    candidatesByUnit.get(c.unit_number).push(c);
  });
}
```

- [ ] **Step 2: Add a name-similarity helper and pre-select logic**

Above the `rows = data.map(...)` block inside `load`, add:

```javascript
const normalizeName = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const nameScore = (signup, candidate) => {
  const a = normalizeName(signup), b = normalizeName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  const aToks = a.split(' '), bToks = b.split(' ');
  const aLast = aToks[aToks.length - 1], bLast = bToks[bToks.length - 1];
  if (aLast === bLast && aToks[0] && bToks[0] && (aToks[0].startsWith(bToks[0]) || bToks[0].startsWith(aToks[0]))) {
    return 0.8;
  }
  const set = new Set(bToks);
  const overlap = aToks.filter((t) => set.has(t)).length;
  return overlap / Math.max(aToks.length, bToks.length);
};
const pickBestCandidate = (signup, candidates) => {
  if (!candidates || candidates.length === 0) return null;
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const s = nameScore(signup.full_name, c.display_name);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return bestScore >= 0.7 ? best : null;
};
```

- [ ] **Step 3: Replace the pending-row action buttons with Approve & Link**

In the `if (r.status === 'pending')` branch, replace the two existing Approve / Reject pushes with:

```javascript
const unitCandidates = candidatesByUnit.get(r.unit_number) || [];
const preSelected = pickBestCandidate(r, unitCandidates);
// Per-row radio group name (avoids collisions between cards).
const radioName = `roster_${r.id}`;

const candidateChoices = unitCandidates.map((c) =>
  el('label', { class: 'admin-candidate' },
    el('input', {
      type: 'radio', name: radioName, value: c.id,
      checked: preSelected && preSelected.id === c.id,
    }),
    el('span', { text: c.display_name }),
  )
);
candidateChoices.push(
  el('label', { class: 'admin-candidate' },
    el('input', {
      type: 'radio', name: radioName, value: '__new__',
      checked: !preSelected,
    }),
    el('span', { text: '+ Create new roster entry' }),
  )
);

const candidatesBlock = el('div', { class: 'admin-candidates' },
  el('div', { class: 'admin-candidates__label', text: `Roster matches for Unit ${r.unit_number || '—'}:` }),
  ...candidateChoices,
);

actions.push(el('button', {
  class: 'btn-mini', type: 'button', text: 'Approve & Link',
  onclick: async () => {
    const picked = document.querySelector(`input[name="${radioName}"]:checked`);
    const residentId = picked && picked.value !== '__new__' ? picked.value : null;
    const { error: rpcErr } = await window.sb.rpc('approve_and_link', {
      p_profile_id:  r.id,
      p_resident_id: residentId,
      p_phone:       r.phone || null,
    });
    if (rpcErr) { alert('Couldn\u2019t approve: ' + rpcErr.message); return; }
    sendWelcome(r.id); // fire-and-forget, matches prior behavior
    load();
  },
}));
actions.push(el('button', {
  class: 'btn-mini btn-mini--danger', type: 'button', text: 'Reject',
  onclick: async () => {
    if (!confirm('Reject ' + (r.full_name || 'this signup') + '? This deletes their account; the email can be used again.')) return;
    await deleteUser(r.id);
    load();
  },
}));

// Replace the `return el('article', ...)` for this branch so the
// candidates block appears between the main info and the action row.
return el('article', { class: 'card liquid-glass admin-row' },
  el('div', { class: 'admin-row__main' },
    el('div', { class: 'admin-row__title', text: (r.full_name || 'Unnamed') + (r.unit_number ? ' · Unit ' + r.unit_number : '') }),
    el('div', { class: 'admin-row__meta' },
      statusPill,
      rolePill,
      r.phone ? el('span', { text: r.phone }) : null,
    ),
    candidatesBlock,
  ),
  el('div', { class: 'admin-row__actions' }, ...actions),
);
```

Keep the non-pending branches (approved + admin / demote / remove) exactly as they are.

- [ ] **Step 4: Add minimal styles for the candidates block**

Append to `assets/styles.css`:

```css
.admin-candidates {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
}
.admin-candidates__label {
  font-size: 12px;
  color: #999;
  margin-bottom: 6px;
}
.admin-candidate {
  display: block;
  padding: 4px 0;
  font-size: 14px;
  cursor: pointer;
}
.admin-candidate input { margin-right: 8px; vertical-align: middle; }
```

- [ ] **Step 5: Manual verification**

1. In an incognito window, sign up as a new test user with name "Ross Test" and unit "103" (or any unit that has an unclaimed candidate).
2. In the admin window, open `/admin/residents.html`.
3. Expected: the pending row shows a "Roster matches for Unit 103:" block with the existing "Ross Vinuya" row pre-selected, plus "+ Create new roster entry".
4. Click "Approve & Link". Expected: the row flips to `approved` and the `residents` row for Ross Vinuya at 103 now has `profile_id` set to the new user (verify in SQL Editor with `select * from residents where unit_number='103';`).
5. Sign in as the new user, open `/directory.html`. Expected: unit 103 card now shows a `Registered` tag on Ross Vinuya and "That's you".

- [ ] **Step 6: Commit**

```bash
git add admin/residents.html assets/styles.css
git commit -m "Admin approval: candidate roster matches + Approve & Link RPC"
```

---

## Task 7: Account page — opt-out toggles for roster visibility

**Files:**
- Modify: `account.html`

- [ ] **Step 1: Replace the `directory_visible` toggle with two roster toggles**

In the HTML form (`<form id="accountForm">`), replace the current `directory_visible` `<label class="toggle">` block with two new toggles:

```html
<label class="toggle">
  <input id="show_in_directory" type="checkbox" />
  <div class="toggle__label">
    <span class="toggle__title">Show me in the directory</span>
    <span class="toggle__hint">Approved residents see your unit and name. Off means you're hidden.</span>
  </div>
  <span class="toggle__switch" aria-hidden="true"></span>
</label>

<label class="toggle">
  <input id="show_phone" type="checkbox" />
  <div class="toggle__label">
    <span class="toggle__title">Show my phone</span>
    <span class="toggle__hint">Your name still appears when this is off; just the phone stays hidden.</span>
  </div>
  <span class="toggle__switch" aria-hidden="true"></span>
</label>

<p id="notLinkedHint" class="toggle__hint" style="display:none; margin-top: -6px;">
  These toggles activate once an admin links your account to the directory.
</p>
```

Also remove the old `directory_visible` input (the one with hint "Other approved residents can see your unit and phone"). Keep `email_news_optin` as-is.

- [ ] **Step 2: Wire the new toggles to `residents`**

Replace the inline script's load + save blocks. The new script reads from `residents` (for the two toggles) alongside `profiles` (for the other fields). Save fans out to both tables.

Replace the entire `(async () => { ... })();` block with:

```javascript
(async () => {
  const f = document.getElementById('accountForm');
  const status = document.getElementById('status');
  const notLinkedHint = document.getElementById('notLinkedHint');

  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return;

  const [profileRes, residentRes] = await Promise.all([
    window.sb.from('profiles')
      .select('full_name, unit_number, phone, email_news_optin')
      .eq('id', session.user.id).single(),
    window.sb.from('residents')
      .select('id, show_in_directory, show_phone')
      .eq('profile_id', session.user.id).maybeSingle(),
  ]);

  if (profileRes.error) {
    status.textContent = 'Couldn\u2019t load your profile: ' + profileRes.error.message;
    return;
  }
  const profile = profileRes.data;
  const resident = residentRes.data; // may be null if admin hasn't linked yet

  f.email.value = session.user.email || '';
  f.full_name.value = profile?.full_name || '';
  f.unit_number.value = profile?.unit_number || '';
  f.phone.value = profile?.phone || '';
  f.email_news_optin.checked = profile?.email_news_optin !== false;

  if (resident) {
    f.show_in_directory.checked = resident.show_in_directory !== false;
    f.show_phone.checked = resident.show_phone !== false;
  } else {
    f.show_in_directory.checked = true;
    f.show_phone.checked = true;
    f.show_in_directory.disabled = true;
    f.show_phone.disabled = true;
    notLinkedHint.style.display = 'block';
  }

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Saving…';

    const profileUpdate = {
      full_name: f.full_name.value.trim(),
      unit_number: f.unit_number.value.trim(),
      phone: f.phone.value.trim(),
      email_news_optin: f.email_news_optin.checked,
    };

    const { error: pErr } = await window.sb
      .from('profiles').update(profileUpdate).eq('id', session.user.id);
    if (pErr) { status.textContent = 'Couldn\u2019t save profile: ' + pErr.message; return; }

    if (resident) {
      const { error: rErr } = await window.sb
        .from('residents')
        .update({
          show_in_directory: f.show_in_directory.checked,
          show_phone: f.show_phone.checked,
        })
        .eq('id', resident.id);
      if (rErr) { status.textContent = 'Profile saved, but couldn\u2019t save directory prefs: ' + rErr.message; return; }
    }

    status.textContent = 'Saved \u2713';
  });

  document.getElementById('signOutBtn').addEventListener('click', async () => {
    if (!confirm('Sign out of ' + (session.user.email || 'this account') + '?')) return;
    await window.sb.auth.signOut();
    location.href = '/';
  });
})();
```

- [ ] **Step 3: Manual verification**

1. Sign in as a user whose account is linked to a resident row (e.g., yourself after Task 6).
2. Open `/account.html`. Expected: "Show me in the directory" and "Show my phone" are enabled and checked.
3. Toggle "Show my phone" off, click Save. Expected: status says `Saved ✓`.
4. Open `/directory.html` in another tab. Expected: your card shows your name but no phone row.
5. Toggle back on, save, verify phone reappears.
6. Sign in as a user whose profile is `pending` and *has no linked resident row* (create one via a fresh signup but don't approve). Expected: the two toggles are disabled and the "These toggles activate once an admin links your account" hint is visible.

- [ ] **Step 4: Commit**

```bash
git add account.html
git commit -m "Account: roster-backed show_in_directory / show_phone toggles"
```

---

## Task 8: Admin roster CRUD page

**Files:**
- Create: `admin/roster.html`

- [ ] **Step 1: Write the page**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0c0a09" />
  <title>Roster · Admin · Sunset Penthouse</title>

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,300..700,30..100;1,9..144,300..700,30..100&family=Geist+Mono:wght@400;500&family=Geist:wght@300;400;500;600&display=swap" />
  <link rel="stylesheet" href="/assets/styles.css?v=8" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head>
<body class="page">

  <main class="page__container">
    <header class="page-header rise delay-1">
      <span class="page-header__kicker">Admin · Roster</span>
      <h1 class="page-header__title">Who's on the roster.</h1>
      <p class="page-header__sub">
        The master list of everyone in the building, whether or not
        they've signed up. Add new residents, edit contact info, flag
        board members, unlink a mis-matched account.
      </p>
    </header>

    <section class="admin-list" style="margin-bottom: 20px;">
      <button id="addBtn" type="button" class="cta cta--solid">+ Add roster entry</button>
    </section>

    <section id="rosterList" class="admin-list" aria-live="polite">
      <div class="empty"><div class="empty__title">Loading…</div></div>
    </section>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="/assets/env.js"></script>
  <script src="/assets/supabase-client.js"></script>
  <script src="/assets/admin-guard.js"></script>
  <script src="/assets/page-shell.js?v=7"></script>
  <script src="/assets/dom.js"></script>
  <script>
    (async () => {
      const list = document.getElementById('rosterList');
      const addBtn = document.getElementById('addBtn');

      const load = async () => {
        const { data, error } = await window.sb
          .from('residents')
          .select('id, unit_number, display_name, phone, is_board_member, occupancy_type, show_in_directory, show_phone, profile_id, sort_order, notes')
          .order('unit_number', { ascending: true })
          .order('sort_order', { ascending: true });

        if (error) {
          mount(list, el('div', { class: 'empty' },
            el('div', { class: 'empty__title', text: 'Trouble loading roster' }),
            el('p', { class: 'empty__sub', text: error.message }),
          ));
          return;
        }

        const rows = (data || []).map((r) => {
          return el('article', { class: 'card liquid-glass admin-row' },
            el('div', { class: 'admin-row__main' },
              el('div', { class: 'admin-row__title', text: `Unit ${r.unit_number} · ${r.display_name}` }),
              el('div', { class: 'admin-row__meta' },
                r.phone ? el('span', { text: r.phone }) : null,
                el('span', { class: 'admin-status-pill', text: r.occupancy_type }),
                r.is_board_member ? el('span', { class: 'admin-status-pill admin-status-pill--admin', text: 'board' }) : null,
                r.profile_id ? el('span', { class: 'admin-status-pill admin-status-pill--approved', text: 'claimed' }) : null,
                !r.show_in_directory ? el('span', { class: 'admin-status-pill', text: 'hidden' }) : null,
                !r.show_phone && r.show_in_directory ? el('span', { class: 'admin-status-pill', text: 'phone hidden' }) : null,
              ),
            ),
            el('div', { class: 'admin-row__actions' },
              el('button', {
                class: 'btn-mini', type: 'button', text: 'Edit',
                onclick: () => openEditor(r),
              }),
              r.profile_id
                ? el('button', {
                    class: 'btn-mini', type: 'button', text: 'Unlink',
                    onclick: async () => {
                      if (!confirm(`Unlink ${r.display_name} from their account? Their login still works; they just stop showing as "claimed."`)) return;
                      const { error: uErr } = await window.sb.from('residents').update({ profile_id: null }).eq('id', r.id);
                      if (uErr) { alert('Couldn\u2019t unlink: ' + uErr.message); return; }
                      load();
                    },
                  })
                : null,
              el('button', {
                class: 'btn-mini btn-mini--danger', type: 'button', text: 'Delete',
                onclick: async () => {
                  const warn = r.profile_id
                    ? `WARNING: ${r.display_name} is linked to a logged-in user. Delete anyway? (Consider Unlink instead.)`
                    : `Delete ${r.display_name}?`;
                  if (!confirm(warn)) return;
                  const { error: dErr } = await window.sb.from('residents').delete().eq('id', r.id);
                  if (dErr) { alert('Couldn\u2019t delete: ' + dErr.message); return; }
                  load();
                },
              }),
            ),
          );
        });

        mount(list, ...rows);
      };

      const openEditor = (r) => {
        // r may be null for a new row.
        const isNew = !r;
        const unit = prompt('Unit number', r?.unit_number || '');
        if (unit === null) return;
        const name = prompt('Display name', r?.display_name || '');
        if (name === null) return;
        const phone = prompt('Phone (E.164, e.g. +13105551234)', r?.phone || '');
        if (phone === null) return;
        const occ = prompt('Occupancy (owner | tenant)', r?.occupancy_type || 'owner');
        if (occ === null || (occ !== 'owner' && occ !== 'tenant')) {
          if (occ !== null) alert('Occupancy must be owner or tenant.');
          return;
        }
        const board = confirm('Is this a board member? (OK = yes, Cancel = no)');
        const visible = confirm('Show in directory? (OK = yes, Cancel = no)');
        const phoneVisible = confirm('Show phone? (OK = yes, Cancel = no)');

        const row = {
          unit_number: unit.trim(),
          display_name: name.trim(),
          phone: phone.trim() || null,
          occupancy_type: occ,
          is_board_member: board,
          show_in_directory: visible,
          show_phone: phoneVisible,
        };

        (async () => {
          if (isNew) {
            const { error: iErr } = await window.sb.from('residents').insert(row);
            if (iErr) { alert('Couldn\u2019t create: ' + iErr.message); return; }
          } else {
            const { error: uErr } = await window.sb.from('residents').update(row).eq('id', r.id);
            if (uErr) { alert('Couldn\u2019t save: ' + uErr.message); return; }
          }
          load();
        })();
      };

      addBtn.addEventListener('click', () => openEditor(null));
      load();
    })();
  </script>
</body>
</html>
```

Prompt-based editing is deliberately basic — kept simple on purpose. The list page carries the full UI; the editor modal is the next iteration (out of scope for this plan).

- [ ] **Step 2: Manual verification**

1. Sign in as admin, visit `/admin/roster.html`. Expected: all 31 rows, grouped visually by unit, showing phone/occupancy/board/claimed pills.
2. Click Edit on any row, change the phone, confirm it saves and reappears.
3. Click + Add roster entry and create a test row for unit 999 with name "Test Tester". Confirm it renders and is visible on `/directory.html`.
4. Delete the test row.
5. Try `/admin/roster.html` while signed in as a non-admin. Expected: `admin-guard.js` redirects to `/`.

- [ ] **Step 3: Commit**

```bash
git add admin/roster.html
git commit -m "Admin roster: CRUD page for resident rows"
```

---

## Task 9: End-to-end smoke test

- [ ] **Step 1: Run through the full journey**

1. Sign out. Sign up as a fresh test user (use a spare email) claiming "Catharine Skipp" in unit 406.
2. As admin, open `/admin/residents.html`. Expected: pending row with candidates block, pre-selecting Catharine Skipp (name matches).
3. Click Approve & Link. Expected: welcome email fires, row disappears from pending.
4. Sign in as the test user. Visit `/directory.html`. Expected: unit 406 card shows Catharine Skipp with `Registered` and "That's you" markers.
5. Visit `/account.html`, toggle `show_phone` off, save. Refresh directory. Expected: phone is hidden for 406.
6. As admin, open `/admin/roster.html`, click Unlink on Catharine Skipp's row. Expected: `claimed` pill goes away; on the test user's `/account.html` the two toggles become disabled.
7. Clean up: delete the test user via `/admin/residents.html` → Remove.

- [ ] **Step 2: Check that nothing broke**

Visit every page while signed in as admin: `/`, `/home.html`, `/news.html`, `/calendar.html`, `/providers.html`, `/directory.html`, `/account.html`, `/admin/residents.html`, `/admin/roster.html`, `/admin/news.html`, `/admin/events.html`, `/admin/providers.html`. No console errors, no blank pages.

- [ ] **Step 3: Final commit if any fix-ups**

If any manual issues surfaced, fix and commit with a descriptive message. Otherwise nothing to commit here.

---

## Deployment note

After all migrations are pushed and the branch is merged to `main`, Vercel auto-deploys the static site. Migration order matters: push 00012 → 00013 → 00014 *before* the frontend deploy reaches users, or the directory page will error on the missing table. Safest order:

1. Merge + push DB migrations first (via `supabase db push` or Studio).
2. Verify migrations applied.
3. Merge + deploy frontend.

Or run the DB migrations in the final commit that also deploys the frontend — Vercel's deploy is fast enough that the window of inconsistency is small.
