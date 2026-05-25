# Admin-Managed Documents Library — Design

**Date:** 2026-05-25
**Status:** Draft for review
**Scope:** Replace the hardcoded `documents.html` list with a database- and storage-backed library that board members manage from the admin area. Add `admin/documents.html` (upload / edit / delete), a private Supabase Storage bucket, a `documents` table with RLS, and migrate the 7 existing files into the new system.

---

## Problem

`documents.html` is hand-written HTML. The 7 files live in the repo under `/docs/*` and each row is hardcoded markup. Adding a PDF today means a developer commits a file and edits HTML — there is no admin UI, no database, and no file storage behind it. A board member ("I'm in admin but don't know where to go") has no way to add a document themselves.

Secondary issue: the current `/docs/*.pdf` files are **publicly fetchable by URL**. Only the listing page is login-gated; the files themselves are not. So "residents-only documents" isn't actually true today.

## Goal

Let board members add, rename, reorder, and remove documents through the existing admin UI — with no developer involvement — while keeping the resident-facing page visually identical. Make the files genuinely residents-only.

## Non-goals (YAGNI)

- No drag-to-reorder (a `sort_order` number on the form is enough).
- No folders / categories / tags.
- No document versioning or history.
- No public/anonymous access. Viewing still requires an approved resident session.
- No edge functions — admin writes and uploads go directly through `supabase-js` with RLS, exactly like the Providers page.

---

## Decisions (confirmed with user)

| Decision | Choice |
|---|---|
| Existing 7 files | Fold them into the new system (one unified, fully-manageable library). |
| Who can view | All signed-in approved residents. Add/edit/delete is board-only. |
| Allowed file types | PDF, Word (.docx), Excel (.xlsx/.xls), images (.jpg/.png). |
| Storage privacy | **Private** bucket + short-lived signed URLs (more secure than today). |

---

## Architecture

Mirrors the existing Providers feature (`providers` table + `admin/providers.html`), with one addition: the actual file bytes live in Supabase Storage, and the table holds metadata + a pointer.

- **Storage bucket `documents`** (private) — holds the files.
- **Table `public.documents`** — one row per document (title, note, pointer to the storage object, size, type, order).
- **`admin/documents.html`** — list + modal CRUD, board-only (`admin-guard.js`).
- **`documents.html`** — reads the table, renders the same `.doc-row` UI, downloads via signed URLs.
- **`admin/index.html`** — new "Documents" tile with a count.

Data flow for an upload: admin picks a file + title/note in the modal → JS uploads bytes to `storage://documents/<uuid>.<ext>` → JS inserts a `documents` row pointing at that object. RLS gates both the storage write and the table write to admins.

Data flow for a resident download: page loads `documents` rows (RLS-filtered) → for each, JS asks Storage for a signed URL (`createSignedUrl(path, 3600, { download: file_name })`) → the row's link points at that URL and downloads with the original filename.

---

## Data model

### Storage bucket (migration `00018`)

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false,
  52428800,  -- 50 MB ceiling (largest current file is the 5.9 MB CC&Rs)
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', -- xlsx
    'application/vnd.ms-excel',                                          -- xls
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', -- docx
    'image/jpeg', 'image/png'
  ]
)
on conflict (id) do nothing;
```

### Table `public.documents` (migration `00017`)

```sql
create table documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  note text,                          -- subtitle, e.g. "Adopted May 2007"
  storage_path text not null unique,  -- object key within the 'documents' bucket
  file_name text not null,            -- original filename, used for download
  mime_type text,
  size_bytes bigint,
  sort_order int not null default 0,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index documents_sort_idx on documents (sort_order, created_at);
```

- `updated_at` auto-managed via the existing `set_updated_at()` trigger (same as `residents`).
- Listing order: `order by sort_order asc, created_at asc`.

---

## RLS

Identical shape to `providers` (see `00006_rls_policies.sql`), using the existing `is_approved_resident()` and `is_approved_admin()` helpers.

```
documents SELECT:  is_approved_resident()
documents INSERT:  is_approved_admin()
documents UPDATE:  is_approved_admin()
documents DELETE:  is_approved_admin()
```

### Storage object policies (on `storage.objects`, `bucket_id = 'documents'`)

```
SELECT (download):           is_approved_resident()
INSERT (upload):             is_approved_admin()
UPDATE (replace/overwrite):  is_approved_admin()
DELETE:                      is_approved_admin()
```

Because the bucket is private, there is no anonymous path to the bytes — a valid approved-resident session is required for the signed URL to be issued.

---

## Admin page — `admin/documents.html`

Clone of `admin/providers.html` structure (header with a "+ Add document" button, a `.admin-list`, and a `<dialog>` modal).

**Modal fields:**
- **File** — `<input type="file">`, required when adding, optional when editing (omitting keeps the current file). `accept` set to the allowed types.
- **Title** — text, required.
- **Note** — text, optional (the subtitle line).
- **Sort order** — number, default `0`.

**Add flow:** validate → `const ext = …; const path = crypto.randomUUID() + '.' + ext;` → `sb.storage.from('documents').upload(path, file)` → on success `sb.from('documents').insert({ title, note, storage_path: path, file_name: file.name, mime_type: file.type, size_bytes: file.size, sort_order, created_by })`. If the row insert fails, delete the just-uploaded object to avoid orphans.

**Edit flow:** update `title/note/sort_order`. If a new file is chosen, upload the new object, update the row's `storage_path/file_name/mime_type/size_bytes`, then delete the old object.

**Delete flow:** confirm → delete the storage object → delete the row. (Order chosen so a failed storage delete doesn't leave a row pointing at nothing; if the object delete fails, surface the error and keep the row.)

List rows show title, type, size, and Edit/Delete — same `.admin-row` styling as providers.

---

## Public page — `documents.html`

Replace the hardcoded `<a class="doc-row">` block with a script that:

1. Loads rows: `sb.from('documents').select('*').order('sort_order').order('created_at')`.
2. Batch-creates signed URLs: `sb.storage.from('documents').createSignedUrls(paths, 3600, { download: true })` (or per-row with the original filename).
3. Renders each row with the existing `.doc-row` markup via `dom.js` helpers: a type badge derived from extension/mime (PDF / XLSX / DOCX / JPG / PNG), `.doc-row__title`, `.doc-row__note`, a human-readable size (`formatBytes`), and the download arrow.
4. Empty / error states reuse the `.empty` pattern from the other pages.

`auth-guard.js` stays (residents-only listing). No visual change for residents.

---

## Admin dashboard tile

In `admin/index.html`, add to the `counts(...)` batch: `counts('documents')`, and add a tile:

```
tile(documentsCount, 'Documents',
     'Upload or remove building PDFs and files.',
     '/admin/documents.html')
```

---

## Migration of the existing 7 files

These files are in the repo today and must end up in the bucket with metadata rows, preserving current order and titles:

| # | Title | Note | File |
|---|---|---|---|
| 0 | Articles of Incorporation | Founding HOA document | articles-of-incorporation.pdf |
| 1 | Bylaws | Adopted May 2007 | bylaws-2007.pdf |
| 2 | CC&Rs | Recorded July 30, 2007 | ccrs-2007.pdf |
| 3 | Rules, Regulations & Fines | Effective January 2020 | rules-regulations-fines-2020.pdf |
| 4 | Condominium Plan | Filed 1990 | condominium-plan-1990.pdf |
| 5 | Building Upgrades | Capital improvement log | building-upgrades.xlsx |
| 6 | Actuator Replacement | Maintenance record | actuator-replacement.pdf |

**Steps:**
1. Upload each file to `storage://documents/<original-filename>` (deterministic key so the seed rows match). Use the Supabase CLI / a one-off script with elevated credentials (these are admin-side, not browser).
2. Seed migration inserts 7 rows with `sort_order = 0..6`, the titles/notes above, `storage_path = '<original-filename>'`, `file_name`, `mime_type`, and **exact** `size_bytes` computed from the files (not the approximate KB/MB labels currently shown).
3. After verifying the new page renders and downloads work, **remove** the 7 static files from `/docs/` and delete the hardcoded list from `documents.html`. (`/docs/superpowers/**` specs/plans stay untouched.)

Old URLs like `/docs/bylaws-2007.pdf` will then 404 — intended; it's what makes them residents-only.

---

## Testing

- **DB/RLS:** as admin, approved resident, and unauth — confirm SELECT returns rows only for approved residents; INSERT/UPDATE/DELETE succeed only for admins.
- **Storage policies:** confirm a non-admin session cannot upload; an approved resident can fetch a signed URL; an unauth caller cannot.
- **Admin UI:** add a test PDF (title + note + order), confirm it appears on both admin and public pages; edit its title; replace its file; delete it and confirm the storage object is gone (no orphan).
- **Migration:** confirm all 7 rows render in the original order with correct sizes, and each downloads with its original filename.
- **Cutover:** confirm `documents.html` shows the dynamic list and the removed static files 404.
- **Orphan handling:** simulate a row-insert failure after upload and confirm the uploaded object is cleaned up.

---

## Files affected / added

**Added:**
- `supabase/migrations/00017_create_documents.sql` — table, index, `set_updated_at` trigger, RLS policies.
- `supabase/migrations/00018_documents_storage.sql` — bucket + `storage.objects` policies.
- `supabase/migrations/00019_seed_documents.sql` — the 7 metadata rows (run after files are uploaded).
- `admin/documents.html` — the CRUD page.
- A one-off upload step/script for the 7 existing files (not committed as app code).

**Modified:**
- `documents.html` — dynamic list + signed-URL downloads.
- `admin/index.html` — add the Documents tile + count.
- Bump `styles.css?v=` only if any CSS is added (the `.doc-row` styles already exist; likely no CSS change).

**Removed (at cutover):**
- `docs/articles-of-incorporation.pdf`, `docs/bylaws-2007.pdf`, `docs/ccrs-2007.pdf`, `docs/rules-regulations-fines-2020.pdf`, `docs/condominium-plan-1990.pdf`, `docs/building-upgrades.xlsx`, `docs/actuator-replacement.pdf`.

**Unchanged:**
- `profiles`, `residents`, all other tables and pages.
- `auth-guard.js`, `admin-guard.js`.

---

## Open questions / judgment calls

- **Object key scheme:** random UUID for new uploads (avoids filename collisions and odd characters); original filenames for the 7 seeded files (so the seed migration is deterministic). Download always uses the stored `file_name`.
- **Delete order (object then row):** chosen so a failed object delete doesn't strip the listing while leaving bytes behind; the admin sees the error and retries. Accepts the small risk of an orphaned object if the row delete later fails — acceptable, and a future cleanup query can catch orphans.
- **Replace-file on edit** is included because it's cheap and board members will want to post corrected versions; can be cut if it complicates the first build.
