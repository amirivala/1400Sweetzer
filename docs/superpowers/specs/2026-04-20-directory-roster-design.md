# Directory + Resident Roster — Design

**Date:** 2026-04-20
**Status:** Draft for review
**Scope:** Rework `directory.html` so it shows every resident of 1400 N Sweetzer (not just signed-up users), grouped by unit, with identity tags (Board, Tenant, Admin, Registered). Introduce an admin-maintained roster as the source of truth, seeded from the HOA's "Homeowner Contact List" PDF (Rev. 4.13.2026).

---

## Problem

Today `directory.html` reads directly from the `profiles` table. A `profiles` row only exists if a user has signed up via Supabase Auth, so the directory is effectively a list of self-service registered users — a small subset of the 28 people across 26 units who actually live here. This makes the page look empty, and it mixes two very different concerns (the official HOA roster vs. who happens to have made an account).

We also have no way to show identity tags that matter to the community — Board Member, Owner vs. Tenant, Admin, Registered — because some of those facts aren't expressible on a `profiles` row at all.

## Goal

Make the directory the **authoritative "who lives here"** view, not a registered-users view. Keep a meaningful distinction between roster data (maintained by admins) and account data (self-service via signup).

## Non-goals

- No public/anonymous access to the directory. Still requires auth.
- No auto-verification based on name matching alone (too easy to impersonate).
- No household/family relationship modeling. Couples who share a line in the PDF become two individual rows that happen to share a phone.
- No SMS/email comms changes. This is a data + UI change only.

---

## Architecture

Two tables working together:

- **`residents`** — the roster. Source of truth for "who lives here." Seeded once from the PDF, maintained by admins thereafter.
- **`profiles`** — unchanged. The auth/account layer. Holds what the user entered during signup. A profile "claims" a resident row via `residents.profile_id`.

Directory page reads from `residents` joined to `profiles` (for the Admin and Registered tags). Signup/approval flow continues to revolve around `profiles`, with one new step: during approval, the admin links the signup to a roster row.

### Industry-standard reasoning

This is how BuildingLink, FrontSteps, HOAStart and similar condo/HOA portals are structured: a management-maintained roster on the bottom, self-service accounts on top, linked during onboarding. It's the standard pattern because it cleanly separates "official record" from "who has shown up."

---

## Data model

### New table: `residents`

```sql
create type resident_occupancy as enum ('owner', 'tenant');

create table residents (
  id uuid primary key default gen_random_uuid(),
  unit_number text not null,
  display_name text not null,
  phone text,                      -- E.164, e.g. '+13105551234'
  is_board_member boolean not null default false,
  occupancy_type resident_occupancy not null default 'owner',
  show_in_directory boolean not null default true,
  show_phone boolean not null default true,
  profile_id uuid unique references profiles(id) on delete set null,
  sort_order int not null default 0,
  notes text,                      -- admin-only free text
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index residents_unit_idx on residents (unit_number);
create index residents_profile_idx on residents (profile_id);
```

Invariants:
- `profile_id` is unique when non-null — a profile claims at most one resident row.
- Deleting a profile sets `profile_id` to null on its resident row (the roster row survives).
- `updated_at` auto-managed via the existing `set_updated_at()` trigger.

### Tag semantics

Each tag the directory displays maps to exactly one source:

| Tag | Source |
|---|---|
| Board | `residents.is_board_member` |
| Tenant | `residents.occupancy_type = 'tenant'` (Owner is the default and is not shown as a tag) |
| Admin | `profiles.role = 'admin'` on the linked profile |
| Registered | `residents.profile_id is not null` |
| You | `residents.profile_id = auth.uid()` |

### Relationship to existing `profiles` columns

`profiles.full_name`, `profiles.unit_number`, `profiles.phone`, and `profiles.directory_visible` become signup-time / vestigial data. They stay in the schema (no destructive migration) but the directory page stops reading them. The signup form continues to populate them so admins have something to match against during approval.

---

## Seed strategy

A one-time migration inserts 28 rows from the PDF. Rules:

**Couples on one line become two rows sharing a phone:**
- `(202)` "Leonard & Rosemary Zir" → `Leonard Zir` + `Rosemary Zir`, phone `+15086557223`.
- `(302)` "Grant & Kristan Morrison" → `Grant Morrison` + `Kristan Morrison`, phone `+13239635411`.

**Same person in multiple units becomes one row per unit:**
- Karen Zambos → two rows (401, 405). Both tagged `is_board_member=true`.
- Geoffrey Smith → two rows (403, 404). Both tagged `is_board_member=true`. (The PDF only stars the 403 entry; we're tagging by person-identity, not by printed-list formatting.)

**Unit 203 tenant/owner split:**
- Bruce Robertson `(T)` → `occupancy_type='tenant'`.
- Mark Scherzer `(O)` → `occupancy_type='owner'`.
- David Thomas `(O)` → `occupancy_type='owner'`.

**Board members** (the three `*` entries on the PDF, plus their other-unit rows where applicable):
- Richard Hynd (201), Karen Zambos (401 + 405), Geoffrey Smith (403 + 404).

**Default occupancy** for all non-203 rows is `owner` (the PDF is titled "Homeowner Contact List").

**Phone normalization:** seed in E.164 (`+1XXXXXXXXXX`). Render as `XXX-XXX-XXXX` visually. A small helper function handles format round-tripping.

**`profile_id` starts null** for all seeded rows, including Amir's (101). Amir self-claims through the same admin flow as everyone else — one click, since he's already an admin.

Seed file: `supabase/migrations/00014_seed_residents.sql` (see Files section for full migration numbering).

---

## Signup → approval → link flow

### Signup page

No changes. User still enters full name, unit, phone. The roster is not exposed to non-authenticated users or to prospective signups, which keeps it private from anyone who hasn't been approved.

### Admin approval page

Today the page shows pending signups with Approve/Reject. After this change, each pending signup renders with an additional "Roster match" block:

```
PENDING   Ross Vinuya  ·  Unit 103  ·  310-729-0481
          ─────────────────────────────────────────
          Roster matches for Unit 103:
            (•)  Ross Vinuya       ← pre-selected by name similarity
            ( )  + Create new roster entry for this signup
          [ Approve & Link ]   [ Reject ]
```

### Match-ranking logic (hint, not gate)

Candidates = `residents` rows where `unit_number = signup.unit_number AND profile_id IS NULL`, ranked by normalized name similarity:

1. Lowercase, strip punctuation and whitespace.
2. Exact normalized match → highest rank.
3. Last-name exact + first-name starts-with → next (handles "Josh" vs "Joshua").
4. Token overlap score → fallback.

If the top candidate's score exceeds a threshold, pre-select it. Otherwise no radio is pre-selected — admin must pick a candidate or choose "Create new" consciously. **The admin click is the verification.** Auto-selection only saves a click on the common case.

### "Approve & Link" behavior

Atomic server-side action (one edge function or RPC):

1. Set `profiles.status = 'approved'`.
2. Set `residents.profile_id = <new user id>` on the chosen row.
3. Overwrite `residents.phone` with the phone the user entered at signup (users know their own number better than the PDF does; stale PDF phones shouldn't linger after claim).
4. Trigger the existing `send_welcome_email` edge function.

### "Create new roster entry"

For residents who aren't on the PDF (moved in after Rev. 4.13.2026). Admin picks this radio → the approve action creates a new `residents` row using the signup's `full_name`, `unit_number`, and `phone`, and links it to the profile. Occupancy defaults to `owner`; admin can edit after the fact from the roster CRUD page.

### Edge cases

- **Wrong unit in signup:** Admin can edit the unit number inline before clicking Approve & Link. (Friendlier than rejecting.)
- **Bad link applied by mistake:** The roster CRUD page (see below) has an Unlink button that clears `profile_id`, allowing re-claim.
- **Stale/deleted auth user:** `on delete set null` on the FK clears `profile_id` automatically; the roster row survives.

---

## Directory page rendering

### Layout

Grouped by `unit_number` ascending; one card per unit containing one or more people. Within a card, people sort by `sort_order` then `display_name`.

```
┌─────────────────────────────────────┐
│  101                                │
│                                     │
│  Amir Alavi            [Admin][You] │
│  📞 678-431-4812                    │
│                                     │
│  Sona Sehat                         │
│  📞 662-617-1928                    │
└─────────────────────────────────────┘
```

Visual specifics inherit from the existing `.dir-card` / liquid-glass styling. Names within a card are separated by a thin divider. Tag chips render inline next to the name. Phone renders as a `tel:` link.

### Visibility rules

- Include a resident if `show_in_directory = true` OR `profile_id = auth.uid()` (you always see yourself, even if hidden).
- Hide the phone line if `show_phone = false`. Name and tags still render.
- A unit card renders only if it contains at least one visible resident.

### Tag styling

- **You** — stays as today's subtle pill (the existing `.dir-card__you` style).
- **Board** — small amber/terracotta chip.
- **Tenant** — small neutral chip.
- **Admin** — small accent chip.
- **Registered** — very subtle indicator (not a loud badge — we don't want to shame unregistered neighbors).

Owner is the default and does not render a chip; adding a chip to the 90% case is just noise.

---

## Admin roster CRUD

New admin-only page (or tab in the existing admin area): table of all `residents` rows, grouped by unit, with inline edit.

Operations:
- Create row (fields: unit, display_name, phone, occupancy_type, is_board_member, show_in_directory, show_phone, notes).
- Edit row — any field.
- Delete row — confirm dialog; hard delete. If the row is claimed (`profile_id` set), warn prominently before deleting and offer Unlink as an alternative.
- Unlink — clears `profile_id` so the row can be re-claimed. The profile itself is untouched.

Search/filter: by unit and by name substring. 28 rows today, might grow slowly; no pagination needed.

---

## Privacy / opt-out UX

The PDF is already circulated in print within the building, so contact visibility roughly matches resident expectations. Two layers of opt-out:

**Registered residents** — new toggles on `/account.html`:
- "Show me in the directory" (writes to `residents.show_in_directory`)
- "Show my phone" (writes to `residents.show_phone`)

RLS lets a non-admin user update only those two fields, only on their own linked `residents` row.

**Unregistered neighbors** — the directory page footer has a short line: "Want to hide your number? Email admin@1400nsweetzer.com." Admin flips the toggle from the roster CRUD page.

---

## RLS policies

```
residents SELECT:
  authenticated users;
  row visible if (show_in_directory = true)
                OR (profile_id = auth.uid())
                OR (user is admin)

residents INSERT / DELETE:
  admins only (profiles.role = 'admin' AND profiles.status = 'approved')

residents UPDATE:
  admins: full access to all fields
  non-admins: only their own linked row (profile_id = auth.uid()),
              only the fields show_in_directory, show_phone
```

The admin check should go through a SECURITY DEFINER helper function that reads `profiles` for the calling user — same pattern as the existing `00006_rls_policies.sql` and `00007_rls_hardening.sql` migrations use.

---

## Testing

- **DB-level:** psql / Supabase SQL Editor integration checks — seed the 28 rows, assert counts, assert Karen Zambos appears in both 401 and 405, assert Bruce Robertson is the only `tenant` in 203.
- **RLS smoke tests:** query `residents` as (a) an admin, (b) an approved resident, (c) an unauth user, (d) a resident whose row has `show_in_directory = false` — confirm only the expected rows come back in each case.
- **UI:** manual walkthrough of directory page as admin, as a regular resident, as the user whose row is hidden. Verify tags, phone visibility, "You" marker, unit grouping.
- **Approval flow:** create a test signup against unit 103, confirm "Ross Vinuya" pre-selects, click Approve & Link, verify `residents.profile_id` is set and `profiles.status` is `approved` and phone got overwritten with the signup value.
- **Edge case — no match:** create a signup for unit 999 (not in PDF), confirm no candidates show, "Create new" path creates and links a new row.

---

## Files affected / added

Added:
- `supabase/migrations/00012_create_residents.sql` — table, enum, trigger, indexes.
- `supabase/migrations/00013_residents_rls.sql` — policies.
- `supabase/migrations/00014_seed_residents.sql` — the 28 rows from the PDF.
- `supabase/functions/approve_and_link/index.ts` — edge function for the atomic approve step (or add to existing admin function).
- `admin-roster.html` (or section within existing admin page) — roster CRUD UI.

Modified:
- `directory.html` — read from `residents`, group by unit, render tags.
- `account.html` — add two opt-out toggles, wire to `residents` row.
- The existing admin approval page — add "Roster matches" block and "Approve & Link" button.

Unchanged:
- `profiles` table schema.
- Signup form.
- Welcome email edge function.

---

## Open questions / judgment calls flagged in design review

- **Tag Karen & Geoffrey as Board on *all* their rows** (not just the starred one). Decided: yes — tag by person-identity, not by PDF formatting. (Approved.)
- **Phone normalization to E.164 on seed.** Decided: yes. (Approved.)
- **Overwrite roster phone with signup phone on link.** Decided: yes — users know their own number better than a printed list. (Implicit in Section 3 approval.)
- **Deprecate `profiles.directory_visible` silently vs. migrate to `residents.show_in_directory`.** Decided: leave the column in place, stop reading it. No destructive migration.
