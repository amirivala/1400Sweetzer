# 1400 Sweetzer Resident Portal — Design Spec

**Date:** 2026-04-17
**Status:** Draft for review

## Overview

A private web portal for residents of the 1400 Sweetzer condo building. Authenticated residents can read building news (with email notifications), see upcoming events, look up other residents (directory), and find recommended service vendors. Admins approve new signups, post news, and manage events, providers, and residents.

Scope: ~30 units, English only, single building, mobile-first.

## Goals

- Residents have one trusted place to read building news and find a neighbor's number.
- Admins can post news and have it reach residents' inboxes within seconds.
- The build is cheap to host (~$10/year) and simple enough for one developer to maintain.
- The visual design has personality — playful, tactile, friendly — not corporate.

## Non-goals (v1)

- Recurring events, RSVP, calendar grid view
- Comments / replies on news posts
- Maintenance ticketing
- Documents library, polls, voting
- Push notifications, native mobile app
- Multilingual UI, dark mode, two-factor auth
- Public-facing pages (entire site is behind login)

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Resident's browser                                    │
│  Vanilla HTML + CSS + JS                               │
│  (supabase-js client for auth, queries, storage)       │
└──────────────────────┬─────────────────────────────────┘
                       │ HTTPS
        ┌──────────────┼──────────────────────┐
        ▼              ▼                      ▼
   Cloudflare      Supabase                Supabase
   Pages          (Auth + Postgres         Edge Function
   (static         + Storage for            "send_news_email"
    site at        cover images)            — runs when news
    1400sweetzer.com)                       post is published)
                       ▲
                       │ Postgres trigger fires on
                       │ INSERT/UPDATE into news_posts
                       │
                  ┌────┴─────┐
                  ▼          ▼
            Resend API   (sends batched emails to
                          opted-in approved residents)
```

**Components:**

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS (multi-page) | Matches developer's existing style; no build step; static deploy is trivial |
| Hosting | Cloudflare Pages | Free, fast, custom domain, GitHub auto-deploy |
| Domain | `1400sweetzer.com` (Cloudflare Registrar) | ~$10/yr, no markup |
| Auth | Supabase Auth (magic link) | No password to forget; lower support burden for non-technical residents |
| Database | Supabase Postgres + RLS | Free tier easily covers scale; RLS enforces access at DB layer |
| File storage | Supabase Storage (cover images) | Same vendor as DB; ~1 GB free |
| Transactional email | Resend | 100/day free; clean API |
| Notification trigger | Supabase Edge Function `send_news_email` | One small server-side function — only place we run code outside the browser |
| CI/CD | GitHub → Cloudflare Pages auto-deploy | Free; push to deploy |
| Rich text editor | Quill (CDN script tag) | No build step; familiar WYSIWYG for non-technical admins |

**Total recurring cost:** ~$10/year for the domain. Everything else fits in free tiers at this scale.

## Data Model

Five tables. `auth.users` (Supabase built-in) handles email + password hash; `profiles` extends it with condo-specific fields.

### `profiles` (extends `auth.users`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | FK to `auth.users.id` |
| `full_name` | text | "Jane Smith" |
| `unit_number` | text | "4B" |
| `phone` | text | for the directory |
| `role` | enum (`resident` \| `admin`) | default `resident` |
| `status` | enum (`pending` \| `approved` \| `removed`) | default `pending` |
| `directory_visible` | bool | resident can hide phone from directory (default `true`) |
| `email_news_optin` | bool | resident toggle for news emails (default `true`) |
| `created_at`, `updated_at` | timestamptz | |

### `news_posts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `title` | text | |
| `body` | text | rich text HTML (from Quill) |
| `cover_image_url` | text | nullable, file in Supabase Storage |
| `author_id` | uuid | FK to `profiles.id` |
| `published` | bool | draft vs live |
| `email_residents` | bool | per-post checkbox |
| `created_at`, `published_at` | timestamptz | |

### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `title` | text | |
| `description` | text | nullable |
| `location` | text | nullable, e.g., "Lobby" |
| `start_at` | timestamptz | |
| `end_at` | timestamptz | nullable |
| `created_by` | uuid | FK to `profiles.id` |
| `created_at` | timestamptz | |

### `providers`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | text | "Acme Plumbing" |
| `category` | text | one of: Plumbing, Electrical, HVAC, Locksmith, Cleaning, Other |
| `phone` | text | |
| `email` | text | nullable |
| `notes` | text | nullable |
| `created_by` | uuid | FK to `profiles.id` |
| `created_at` | timestamptz | |

### `admin_actions` (audit log)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `actor_id` | uuid | FK to `profiles.id` (the admin) |
| `action` | text | e.g., `approve_signup`, `remove_resident`, `publish_news`, `delete_event` |
| `target_type` | text | e.g., `profile`, `news_post`, `event`, `provider` |
| `target_id` | uuid | id of the affected row |
| `created_at` | timestamptz | |

The directory page is a derived view: `SELECT full_name, unit_number, phone FROM profiles WHERE status='approved' AND directory_visible=true`.

### Row Level Security (RLS)

- **Approved residents** can `SELECT` from `news_posts` (where `published=true`), `events`, `providers`, `profiles` (limited to directory-visible columns).
- **Approved residents** can `UPDATE` only their own `profiles` row (and only specific columns: `full_name`, `phone`, `directory_visible`, `email_news_optin`).
- **Admins** can `INSERT`/`UPDATE`/`DELETE` on `news_posts`, `events`, `providers`. Admins can `UPDATE` any `profiles` row (status, role).
- **Pending or removed users** cannot read anything except their own `profiles` row.
- The Edge Function uses the service-role key and bypasses RLS for batch email sends.

## Auth & Approval Flow

**Sign-in:** Magic link only (no passwords).

**Sign-up flow:**

1. Visitor lands on `1400sweetzer.com` → public landing page with "Sign in" / "Sign up" CTAs.
2. Click "Sign up" → form: full name, email, unit number, phone → submit.
3. Submit creates `auth.users` row + `profiles` row with `status='pending'`, `role='resident'`.
4. Resident sees "Account pending" page.
5. Postgres trigger on insert fires Edge Function → emails ALL admins: "New signup: Jane Smith, Unit 4B → [Review]" linking to `/admin/pending.html`.
6. Admin opens pending list, clicks Approve or Reject.
7. **Approve:** `status='approved'`; Edge Function sends magic-link welcome email to resident.
8. **Reject:** `status='removed'` (soft delete).

**Sign-in flow (returning resident):**

1. Enter email → "Check your email for a sign-in link".
2. Click link → session set in browser.
3. If `profile.status != 'approved'` → redirect to `/pending.html`.
4. Otherwise → `/home.html`.

**Removing a resident:** Admin clicks Remove on a `/admin/residents.html` row → `status='removed'`. The resident's existing session token remains valid until expiry, but RLS will return no data, and the auth-guard on every page will redirect them to the "removed" view. (Optional hardening: admin action also calls `auth.admin.signOut(userId)` via the Edge Function to force-revoke.)

**Bootstrapping the first admin:** Owner signs up normally, then runs one SQL query in Supabase's dashboard to flip their `role` to `admin`. Documented in `README.md`. After that, admins can promote others via the residents page.

**Defense in depth:**

1. Manual admin approval keeps strangers out.
2. Postgres RLS enforces access at the database layer.
3. Edge Function checks role server-side before any privileged action.

## Pages & Navigation

Multi-page app: each route is its own `.html` file. Shared `header.js` / `footer.js` snippets render consistent nav. `auth-guard.js` runs on every protected page to redirect unauthenticated/unapproved users.

| Path | Audience | Purpose |
|---|---|---|
| `/` (`index.html`) | Public | Landing page — building name, Sign in / Sign up CTAs |
| `/signup.html` | Public | Sign-up form |
| `/auth/callback.html` | Public | Magic-link redirect handler |
| `/pending.html` | Pending | "Waiting for approval" message |
| `/home.html` | Approved residents | News feed (chronological) |
| `/news.html?id=...` | Approved residents | Single news post |
| `/calendar.html` | Approved residents | Upcoming events list |
| `/directory.html` | Approved residents | Resident directory |
| `/providers.html` | Approved residents | Service vendors list |
| `/account.html` | Approved residents | Edit own profile + opt-ins |
| `/admin/index.html` | Admins | Dashboard overview |
| `/admin/pending.html` | Admins | Pending signups → approve/reject |
| `/admin/residents.html` | Admins | All residents → make admin, remove |
| `/admin/news/edit.html` | Admins | Rich text news editor |
| `/admin/events/edit.html` | Admins | Event editor |
| `/admin/providers/edit.html` | Admins | Provider editor |

**Top nav (desktop, signed-in):** `[1400 Sweetzer]   News   Calendar   Directory   Providers   Account ▾   (Admin if applicable)`

**Mobile (< 700px):** Bottom-bar icon nav (Home / Calendar / Directory / Providers / Account).

## File / Repo Structure

```
1400Website/
├── index.html              ← public landing
├── signup.html
├── pending.html
├── home.html               ← news feed
├── news.html               ← single post
├── calendar.html
├── directory.html
├── providers.html
├── account.html
├── admin/
│   ├── index.html
│   ├── pending.html
│   ├── residents.html
│   ├── news/edit.html
│   ├── events/edit.html
│   └── providers/edit.html
├── auth/callback.html
├── assets/
│   ├── styles.css
│   ├── supabase-client.js
│   ├── header.js
│   ├── auth-guard.js
│   └── pages/
│       ├── home.js
│       ├── news.js
│       └── ...
├── supabase/
│   ├── migrations/         ← SQL schema files
│   └── functions/
│       └── send_news_email/
│           └── index.ts
├── docs/
│   └── superpowers/specs/  ← this file
└── README.md
```

## News + Email Pipeline

**Authoring (`/admin/news/edit.html`):**

- Title (text input)
- Cover image (optional, uploaded to Supabase Storage bucket `news-covers/`)
- Body (Quill WYSIWYG — stored as HTML in `news_posts.body`)
- Checkbox: "Email residents about this post" (default on)
- Buttons: Save draft (`published=false`) / Publish (`published=true`, `published_at=now()`)

**Trigger chain:**

```
INSERT or UPDATE on news_posts WHERE published=true AND email_residents=true
        ↓
Supabase Database Webhook (or Postgres trigger using pg_net.http_post)
calls Edge Function URL with { post_id, event_type }
        ↓
Edge Function `send_news_email`:
  1. Fetch post by id
  2. Fetch all profiles WHERE status='approved' AND email_news_optin=true
  3. Build HTML email (title, hero, ~200 char excerpt, CTA)
  4. Call Resend batch API
  5. Log result (success / failure count)
```

**Email template:** Branded header, optional cover image, post title, ~200-char excerpt, "Read full post" button linking to `/news.html?id=...`, footer with "Manage email preferences" link to `/account.html`.

**Sender address:** `notices@1400sweetzer.com` (verified in Resend via DNS).

**Edge cases:**

- Un-publishing a post: removes from feed, no retraction email.
- Editing an already-published post: no re-send by default. The webhook payload includes `event_type`; the Edge Function only sends on `INSERT` or on transition from unpublished → published, not on subsequent edits.
- Resend API failure: Edge Function logs error; manual retry button is post-v1.
- Resident with `email_news_optin=false`: still sees post in feed, no email.

## Visual Style

**Personality:** Playful but legible. Building portal, not portfolio piece — but with character residents will smile at.

**Typography:**
- Display: Inter Display or General Sans for headlines (architectural feel)
- Body: Inter or system sans
- Mono variant for unit numbers, dates, phones

**Color:**
- Warm muted "building" palette — soft sand or terra cotta primary, off-white background, deep ink text
- One vivid accent (coral or amber) for CTAs and active states
- No dark mode in v1

**Motion / interactions:**
- News cards: gentle hover lift + shadow change
- Buttons: 2-3% scale-down on press
- Page transitions: ~150ms fade + slight upward translate
- Approval action: small confetti burst + row slide-out
- Empty states: playful illustrations + copy ("No events yet — quiet month")
- Tap-to-call on phone numbers (mobile)

**Mobile-first:**
- Single column everywhere
- Tap targets ≥ 44px
- Bottom-bar nav on mobile, top-bar on desktop
- Hero images crop to 16:9 on phones

**Page-specific:**
- Landing: Big "1400 SWEETZER" wordmark, tagline, building illustration or photo, two CTAs
- News feed: Magazine-style — first post featured larger, rest in vertical card stack
- Calendar: Cards with big "torn calendar page" date block on left
- Pending: Warm "you're on the list" message + small animated illustration

## Risks & Open Items

- **Email deliverability:** Verify domain in Resend (5-min DNS step) or emails will spam-filter.
- **First-admin bootstrap:** One-time SQL query in Supabase dashboard — document in README.
- **GDPR / hard delete:** Removed residents are soft-deleted. Hard delete is a manual SQL step in v1; acceptable at this scale.
- **Storage cap:** Free tier is 1 GB; ~2,000 cover images at 500 KB each. Plenty.
- **Provider categories:** Fixed list in v1; admin-customizable later if needed.

## Build Phase Order (high level)

1. **Foundations** — Supabase project, schema + RLS, Cloudflare Pages + GitHub repo, domain DNS, Resend setup, magic-link auth working with a test user.
2. **Auth & approval flow** — signup form, pending state, admin approval UI, email triggers.
3. **Resident pages** — home/news feed, news detail, calendar, directory, providers, account.
4. **Admin pages** — dashboard, residents, news editor (Quill), event editor, provider editor.
5. **Email pipeline** — Postgres trigger → Edge Function → Resend → resident inbox.
6. **Visual polish** — typography, colors, motion, empty states, mobile bottom nav.
7. **Pre-launch checks** — manual end-to-end test, deliverability test, RLS audit, deploy.

Phases 1-3 are usable for internal testing before 4-6 are done. Detailed implementation plan to follow.
