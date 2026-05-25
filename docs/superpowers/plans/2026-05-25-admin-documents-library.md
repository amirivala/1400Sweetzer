# Admin-Managed Documents Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `documents.html` list with a Supabase-backed library that board members manage from the admin area (upload / rename / reorder / delete), keeping the resident page visually identical and making files genuinely residents-only.

**Architecture:** A private Storage bucket `documents` holds the files; a `public.documents` table holds metadata + a pointer. RLS mirrors the existing `providers` feature (approved residents read, admins write). A new `admin/documents.html` does CRUD via `supabase-js` + Storage; `documents.html` reads the table and downloads via short-lived signed URLs. The 7 existing files are imported once into the new system, then their static copies are removed.

**Tech Stack:** Static HTML + vanilla JS, `@supabase/supabase-js@2` (CDN), Supabase Postgres + Storage, Supabase CLI (`db push`, `db query --linked`, `storage cp --linked`). DOM built with the project's `assets/dom.js` helpers (`el`, `mount`).

**Spec:** `docs/superpowers/specs/2026-05-25-admin-documents-library-design.md`

---

## Testing convention for this project

This codebase has **no JS test framework**; its established testing pattern (see prior specs) is **SQL/RLS assertions via `supabase db query --linked`** plus **manual UI walkthroughs while signed in**. We follow that here:
- Data/RLS layers are verified with concrete `supabase db query --linked` commands and expected output.
- Authed pages (`documents.html`, `admin/documents.html`) redirect unauthenticated visitors via `auth-guard.js` / `admin-guard.js`, so they're verified with a **signed-in admin walkthrough** (the executor coordinates a logged-in session). Local rendering sanity is still checked with the static server where useful.

**Deviation from spec:** the spec listed a committed `00019_seed_documents.sql`. We instead import the 7 existing files as a **one-off production operation** (upload + `INSERT` via `db query --linked`) so a fresh DB reset doesn't leave rows pointing at storage objects that don't exist. The schema migrations (00017, 00018) are still committed.

**Note on `db query --linked` writes:** it connects via the Management API as a project-owner role that **bypasses RLS** (confirmed: a prior admin DELETE on `residents` succeeded this way). `documents` has no protective triggers, so the seed `INSERT` will apply directly.

---

## File structure

**Created:**
- `supabase/migrations/00017_create_documents.sql` — `documents` table, index, `set_updated_at` trigger, RLS policies.
- `supabase/migrations/00018_documents_storage.sql` — private bucket + `storage.objects` policies.
- `admin/documents.html` — board-only CRUD page (clone of `admin/providers.html` + file upload).

**Modified:**
- `documents.html` — dynamic list + signed-URL downloads (replaces hardcoded `<a class="doc-row">` block).
- `admin/index.html` — add `documents` count + "Documents" tile.

**Removed (cutover, Task 7):**
- `docs/articles-of-incorporation.pdf`, `docs/bylaws-2007.pdf`, `docs/ccrs-2007.pdf`, `docs/rules-regulations-fines-2020.pdf`, `docs/condominium-plan-1990.pdf`, `docs/building-upgrades.xlsx`, `docs/actuator-replacement.pdf`.

No CSS changes: `.doc-row*`, `.admin-list`, `.admin-row*`, `.modal*`, `.account-row`, `.cta*`, `.empty*` all already exist in `assets/styles.css`. (So no `styles.css?v=` bump needed.)

---

### Task 1: `documents` table + RLS migration

**Files:**
- Create: `supabase/migrations/00017_create_documents.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00017_create_documents.sql
-- Documents library: metadata for files stored in the private 'documents' bucket.
-- Mirrors the providers RLS shape: approved residents read; admins write.

create table if not exists documents (
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

create index if not exists documents_sort_idx on documents (sort_order, created_at);

-- Reuse the existing shared trigger function (also used by residents).
create trigger documents_updated_at
  before update on documents
  for each row execute function set_updated_at();

alter table documents enable row level security;

create policy "approved residents can read documents"
  on documents for select using (is_approved_resident());

create policy "admins can insert documents"
  on documents for insert with check (is_approved_admin());
create policy "admins can update documents"
  on documents for update using (is_approved_admin()) with check (is_approved_admin());
create policy "admins can delete documents"
  on documents for delete using (is_approved_admin());
```

- [ ] **Step 2: Push the migration to the linked project**

Run: `supabase db push`
Expected: applies `00017_create_documents.sql` with no error (lists it as a new migration and finishes).

- [ ] **Step 3: Verify the table, trigger, and policies exist**

Run:
```bash
supabase db query --linked --output table "select policyname, cmd from pg_policies where tablename='documents' order by cmd;"
```
Expected: 4 rows — SELECT (approved residents can read documents), INSERT (admins can insert documents), UPDATE (admins can update documents), DELETE (admins can delete documents).

Run:
```bash
supabase db query --linked --output table "select column_name from information_schema.columns where table_name='documents' order by ordinal_position;"
```
Expected: id, title, note, storage_path, file_name, mime_type, size_bytes, sort_order, created_by, created_at, updated_at.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00017_create_documents.sql
git commit -m "DB: documents table + RLS (residents read, admins write)"
```

---

### Task 2: Private storage bucket + object policies migration

**Files:**
- Create: `supabase/migrations/00018_documents_storage.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00018_documents_storage.sql
-- Private bucket for the documents library + RLS on storage.objects.
-- Approved residents can download; admins can upload/replace/delete.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false,
  52428800,  -- 50 MB ceiling; largest current file is the 5.9 MB CC&Rs
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',          -- xlsx
    'application/vnd.ms-excel',                                                   -- xls
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',    -- docx
    'image/jpeg', 'image/png'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "approved residents can read document objects"
  on storage.objects for select
  using (bucket_id = 'documents' and is_approved_resident());

create policy "admins can upload document objects"
  on storage.objects for insert
  with check (bucket_id = 'documents' and is_approved_admin());

create policy "admins can update document objects"
  on storage.objects for update
  using (bucket_id = 'documents' and is_approved_admin())
  with check (bucket_id = 'documents' and is_approved_admin());

create policy "admins can delete document objects"
  on storage.objects for delete
  using (bucket_id = 'documents' and is_approved_admin());
```

- [ ] **Step 2: Push the migration**

Run: `supabase db push`
Expected: applies `00018_documents_storage.sql` with no error.

- [ ] **Step 3: Verify the bucket and policies**

Run:
```bash
supabase db query --linked --output table "select id, public, file_size_limit from storage.buckets where id='documents';"
```
Expected: one row — `documents`, public = `false`, file_size_limit = `52428800`.

Run:
```bash
supabase db query --linked --output table "select policyname, cmd from pg_policies where schemaname='storage' and tablename='objects' and policyname like '%document objects%' order by cmd;"
```
Expected: 4 rows (SELECT/INSERT/UPDATE/DELETE) for the document-object policies.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00018_documents_storage.sql
git commit -m "DB: private 'documents' storage bucket + object RLS"
```

---

### Task 3: Import the 7 existing files (one-off production op)

**Files:** none committed. Uses the files currently in `docs/`.

- [ ] **Step 1: Upload the 7 files to the bucket**

Run (from repo root):
```bash
cd /Users/amir/WORX/1400Sweetzer
supabase storage cp ./docs/articles-of-incorporation.pdf      ss:///documents/articles-of-incorporation.pdf      --linked
supabase storage cp ./docs/bylaws-2007.pdf                    ss:///documents/bylaws-2007.pdf                    --linked
supabase storage cp ./docs/ccrs-2007.pdf                      ss:///documents/ccrs-2007.pdf                      --linked
supabase storage cp ./docs/rules-regulations-fines-2020.pdf   ss:///documents/rules-regulations-fines-2020.pdf   --linked
supabase storage cp ./docs/condominium-plan-1990.pdf          ss:///documents/condominium-plan-1990.pdf          --linked
supabase storage cp ./docs/building-upgrades.xlsx             ss:///documents/building-upgrades.xlsx             --linked
supabase storage cp ./docs/actuator-replacement.pdf           ss:///documents/actuator-replacement.pdf           --linked
```
Expected: each prints an upload/finish line with no error.

- [ ] **Step 2: Verify all 7 objects are in the bucket**

Run: `supabase storage ls ss:///documents/ --linked`
Expected: lists the 7 filenames above.

- [ ] **Step 3: Insert the 7 metadata rows (exact sizes, preserving current order)**

Run:
```bash
supabase db query --linked "insert into documents (title, note, storage_path, file_name, mime_type, size_bytes, sort_order) values
('Articles of Incorporation','Founding HOA document','articles-of-incorporation.pdf','articles-of-incorporation.pdf','application/pdf',680883,0),
('Bylaws','Adopted May 2007','bylaws-2007.pdf','bylaws-2007.pdf','application/pdf',161436,1),
('CC&Rs','Recorded July 30, 2007','ccrs-2007.pdf','ccrs-2007.pdf','application/pdf',6141431,2),
('Rules, Regulations & Fines','Effective January 2020','rules-regulations-fines-2020.pdf','rules-regulations-fines-2020.pdf','application/pdf',232515,3),
('Condominium Plan','Filed 1990','condominium-plan-1990.pdf','condominium-plan-1990.pdf','application/pdf',4364785,4),
('Building Upgrades','Capital improvement log','building-upgrades.xlsx','building-upgrades.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',11577,5),
('Actuator Replacement','Maintenance record','actuator-replacement.pdf','actuator-replacement.pdf','application/pdf',66528,6);"
```
Expected: no error.

- [ ] **Step 4: Verify the rows**

Run:
```bash
supabase db query --linked --output table "select sort_order, title, file_name, size_bytes from documents order by sort_order;"
```
Expected: 7 rows in order 0–6 with the titles/files/sizes above.

(No commit — this is data, not code.)

---

### Task 4: Admin CRUD page `admin/documents.html`

**Files:**
- Create: `admin/documents.html`

- [ ] **Step 1: Write the page**

Create `admin/documents.html` with this exact content:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0c0a09" />
  <title>Documents · Admin · Sunset Penthouse</title>

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,300..700,30..100;1,9..144,300..700,30..100&family=Geist+Mono:wght@400;500&family=Geist:wght@300;400;500;600&display=swap" />
  <link rel="stylesheet" href="/assets/styles.css?v=16" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head>
<body class="page">

  <main class="page__container">
    <header class="page-header rise delay-1">
      <span class="page-header__kicker">Admin · Documents</span>
      <div class="page-header__row">
        <div>
          <h1 class="page-header__title">The library.</h1>
          <p class="page-header__sub">Upload PDFs and files for residents to read or download. Only board members can add or remove them.</p>
        </div>
        <button class="cta cta--solid" id="newBtn" type="button"><span>+ Add document</span></button>
      </div>
    </header>

    <section id="docList" class="admin-list" aria-live="polite">
      <div class="empty"><div class="empty__title">Loading…</div></div>
    </section>
  </main>

  <dialog id="docDialog" class="modal liquid-glass-strong">
    <div class="modal__inner">
      <button class="modal__close" id="closeBtn" type="button" aria-label="Close">×</button>
      <h2 class="modal__title" id="dialogTitle">Add document</h2>

      <form id="docForm" autocomplete="off">
        <div class="account-row" style="margin-bottom: 0.8rem;">
          <label for="d_file">File</label>
          <input id="d_file" type="file"
                 accept=".pdf,.xlsx,.xls,.docx,.jpg,.jpeg,.png,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png" />
          <span id="d_fileHint" class="account-hint"></span>
        </div>
        <div class="account-row" style="margin-bottom: 0.8rem;">
          <label for="d_title">Title</label>
          <input id="d_title" type="text" required maxlength="160" placeholder="Bylaws" />
        </div>
        <div class="account-row" style="margin-bottom: 0.8rem;">
          <label for="d_note">Note (optional)</label>
          <input id="d_note" type="text" maxlength="200" placeholder="Adopted May 2007" />
        </div>
        <div class="account-row" style="margin-bottom: 0.4rem;">
          <label for="d_sort">Sort order</label>
          <input id="d_sort" type="number" value="0" step="1" />
        </div>

        <div class="modal-actions">
          <p id="formError" class="modal-error" role="alert"></p>
          <button type="button" class="cta liquid-glass-strong" id="cancelBtn"><span>Cancel</span></button>
          <button type="submit" class="cta cta--solid" id="submitBtn"><span id="submitLabel">Add document</span></button>
        </div>
      </form>
    </div>
  </dialog>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="/assets/env.js"></script>
  <script src="/assets/supabase-client.js"></script>
  <script src="/assets/admin-guard.js"></script>
  <script src="/assets/page-shell.js?v=10"></script>
  <script src="/assets/dom.js"></script>
  <script>
    (async () => {
      const list        = document.getElementById('docList');
      const dialog      = document.getElementById('docDialog');
      const dlgTitle    = document.getElementById('dialogTitle');
      const newBtn      = document.getElementById('newBtn');
      const closeBtn    = document.getElementById('closeBtn');
      const cancelBtn   = document.getElementById('cancelBtn');
      const form        = document.getElementById('docForm');
      const formError   = document.getElementById('formError');
      const submitLabel = document.getElementById('submitLabel');
      const fields = {
        file:  document.getElementById('d_file'),
        title: document.getElementById('d_title'),
        note:  document.getElementById('d_note'),
        sort:  document.getElementById('d_sort'),
      };

      const { data: { session } } = await window.sb.auth.getSession();
      if (!session) return;

      const BUCKET = 'documents';
      let editing = null; // the row being edited, or null when adding

      const fmtBytes = (n) => {
        if (n == null) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
        return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
      };
      const extOf = (name) => (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
      const badge = (name) => (extOf(name) || 'file').toUpperCase();

      const open = (d) => {
        editing = d || null;
        dlgTitle.textContent   = d ? 'Edit document' : 'Add document';
        submitLabel.textContent = d ? 'Save' : 'Add document';
        formError.textContent  = '';
        fields.file.value  = '';
        fields.title.value = d?.title || '';
        fields.note.value  = d?.note || '';
        fields.sort.value  = d ? String(d.sort_order) : '0';
        document.getElementById('d_fileHint').textContent =
          d ? ('Current: ' + d.file_name + ' — choose a file only to replace it.') : '';
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      };
      const close = () => {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      };

      newBtn.addEventListener('click', () => open(null));
      closeBtn.addEventListener('click', close);
      cancelBtn.addEventListener('click', close);
      dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        formError.textContent = '';
        const title = fields.title.value.trim();
        const file  = fields.file.files[0] || null;
        if (!title) { formError.textContent = 'Title is required.'; return; }
        if (!editing && !file) { formError.textContent = 'Choose a file to upload.'; return; }

        const meta = {
          title,
          note: fields.note.value.trim() || null,
          sort_order: parseInt(fields.sort.value, 10) || 0,
        };

        submitLabel.textContent = 'Saving…';

        // Upload a new object if a file was chosen.
        let newPath = null;
        if (file) {
          newPath = crypto.randomUUID() + (extOf(file.name) ? '.' + extOf(file.name) : '');
          const { error: upErr } = await window.sb.storage.from(BUCKET)
            .upload(newPath, file, { contentType: file.type || undefined, upsert: false });
          if (upErr) { submitLabel.textContent = editing ? 'Save' : 'Add document';
            formError.textContent = 'Upload failed: ' + upErr.message; return; }
          meta.storage_path = newPath;
          meta.file_name    = file.name;
          meta.mime_type    = file.type || null;
          meta.size_bytes   = file.size;
        }

        let dbErr;
        if (editing) {
          ({ error: dbErr } = await window.sb.from('documents').update(meta).eq('id', editing.id));
        } else {
          meta.created_by = session.user.id;
          ({ error: dbErr } = await window.sb.from('documents').insert(meta));
        }

        if (dbErr) {
          if (newPath) await window.sb.storage.from(BUCKET).remove([newPath]); // avoid orphan
          submitLabel.textContent = editing ? 'Save' : 'Add document';
          formError.textContent = 'Couldn’t save: ' + dbErr.message;
          return;
        }

        // On a successful file replacement, delete the old object.
        if (editing && newPath && editing.storage_path && editing.storage_path !== newPath) {
          await window.sb.storage.from(BUCKET).remove([editing.storage_path]);
        }

        close();
        load();
      });

      const load = async () => {
        const { data, error } = await window.sb
          .from('documents')
          .select('id, title, note, storage_path, file_name, mime_type, size_bytes, sort_order')
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true });

        if (error) {
          mount(list, el('div', { class: 'empty' },
            el('div', { class: 'empty__title', text: 'Trouble loading documents' }),
            el('p', { class: 'empty__sub', text: error.message })));
          return;
        }
        if (!data || data.length === 0) {
          mount(list, el('div', { class: 'empty' },
            el('div', { class: 'empty__title', text: 'No documents yet' }),
            el('p', { class: 'empty__sub', text: 'Tap “Add document” to upload one.' })));
          return;
        }

        const rows = data.map((d) =>
          el('article', { class: 'card liquid-glass admin-row' },
            el('div', { class: 'admin-row__main' },
              el('div', { class: 'admin-row__title', text: d.title }),
              el('div', { class: 'admin-row__meta' },
                el('span', { text: badge(d.file_name) }),
                el('span', { text: '· ' + fmtBytes(d.size_bytes) }),
                d.note ? el('span', { text: '· ' + d.note }) : null,
              ),
            ),
            el('div', { class: 'admin-row__actions' },
              el('button', { class: 'btn-mini', type: 'button', text: 'Edit',
                onclick: () => open(d) }),
              el('button', { class: 'btn-mini btn-mini--danger', type: 'button', text: 'Delete',
                onclick: async () => {
                  if (!confirm('Delete “' + d.title + '”?')) return;
                  const { error: sErr } = await window.sb.storage.from(BUCKET).remove([d.storage_path]);
                  if (sErr) { alert('Couldn’t delete the file: ' + sErr.message); return; }
                  const { error: dErr } = await window.sb.from('documents').delete().eq('id', d.id);
                  if (dErr) { alert('File removed but row delete failed: ' + dErr.message); return; }
                  load();
                } }),
            ),
          ));

        mount(list, ...rows);
      };

      load();
    })();
  </script>
</body>
</html>
```

- [ ] **Step 2: Sanity-check the static markup loads**

Run:
```bash
cd /Users/amir/WORX/1400Sweetzer && (python3 -m http.server 8765 >/tmp/sp_server.log 2>&1 &) ; sleep 1 ; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8765/admin/documents.html
```
Expected: `200`.

- [ ] **Step 3: Verify the admin gate redirects when unauthenticated (Playwright)**

Navigate to `http://localhost:8765/admin/documents.html` with no session and confirm `admin-guard.js` redirects away from the admin page (URL becomes `/` or `/home.html`). Expected: not still on `/admin/documents.html`.

- [ ] **Step 4: Signed-in admin walkthrough**

While signed in as an approved admin (coordinate a logged-in browser session):
- The 7 imported documents render with title, type badge, size, and note.
- "Add document" → pick a small test PDF, title "Test Doc", note "delete me", sort 99 → Save → it appears in the list and on the public page.
- Confirm the object + row exist:
  ```bash
  supabase db query --linked --output table "select title, file_name, size_bytes, sort_order from documents where title='Test Doc';"
  ```
  Expected: one row.
- "Edit" the test doc → change title to "Test Doc 2" → Save → list updates.
- "Delete" the test doc → confirm → it disappears, and:
  ```bash
  supabase db query --linked --output table "select count(*) from documents where title like 'Test Doc%';"
  ```
  Expected: `0`. Also confirm the storage object is gone: `supabase storage ls ss:///documents/ --linked` shows no stray UUID-named object from the test.

- [ ] **Step 5: Commit**

```bash
git add admin/documents.html
git commit -m "Admin: documents CRUD page (upload/edit/delete to storage + table)"
```

---

### Task 5: Public `documents.html` dynamic rendering

**Files:**
- Modify: `documents.html` (replace the `<section class="docs-list">…</section>` block and remove the now-unused `download` attributes; keep the head/scripts).

- [ ] **Step 1: Replace the static list section**

In `documents.html`, replace the entire `<section class="docs-list" aria-label="Documents"> … </section>` block with:

```html
    <section id="docsList" class="docs-list" aria-label="Documents" aria-live="polite">
      <div class="empty"><div class="empty__title">Loading…</div></div>
    </section>
```

- [ ] **Step 2: Add the rendering script before `</body>`**

In `documents.html`, the existing scripts end with `page-shell.js`. Add `dom.js` and the render script so the closing scripts read exactly:

```html
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="/assets/env.js"></script>
  <script src="/assets/supabase-client.js"></script>
  <script src="/assets/auth-guard.js"></script>
  <script src="/assets/page-shell.js?v=10"></script>
  <script src="/assets/dom.js"></script>
  <script>
    (async () => {
      const wrap = document.getElementById('docsList');
      const { data: { session } } = await window.sb.auth.getSession();
      if (!session) return; // auth-guard handles the redirect

      const BUCKET = 'documents';
      const fmtBytes = (n) => {
        if (n == null) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
        return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
      };
      const badge = (name) => {
        const ext = (name.includes('.') ? name.split('.').pop() : 'file');
        return ext.toUpperCase();
      };
      const arrow = () => {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'doc-row__arrow');
        svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.2');
        svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        const p1 = document.createElementNS(NS, 'path'); p1.setAttribute('d', 'M12 4v14');
        const p2 = document.createElementNS(NS, 'path'); p2.setAttribute('d', 'M5 11l7 7 7-7');
        svg.appendChild(p1); svg.appendChild(p2);
        return svg;
      };

      const { data: docs, error } = await window.sb
        .from('documents')
        .select('id, title, note, storage_path, file_name, size_bytes, sort_order')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });

      if (error) {
        mount(wrap, el('div', { class: 'empty' },
          el('div', { class: 'empty__title', text: 'Trouble loading documents' }),
          el('p', { class: 'empty__sub', text: error.message })));
        return;
      }
      if (!docs || docs.length === 0) {
        mount(wrap, el('div', { class: 'empty' },
          el('div', { class: 'empty__title', text: 'No documents yet' }),
          el('p', { class: 'empty__sub', text: 'Documents posted by the board will appear here.' })));
        return;
      }

      const rows = [];
      for (const d of docs) {
        // Short-lived signed URL; forces download with the original filename.
        const { data: signed } = await window.sb.storage.from(BUCKET)
          .createSignedUrl(d.storage_path, 3600, { download: d.file_name });
        const href = signed?.signedUrl || '#';
        rows.push(
          el('a', { class: 'doc-row liquid-glass rise', href, ...(href === '#' ? {} : { download: d.file_name }) },
            el('span', { class: 'doc-row__type', text: badge(d.file_name) }),
            el('span', { class: 'doc-row__body' },
              el('span', { class: 'doc-row__title', text: d.title }),
              d.note ? el('span', { class: 'doc-row__note', text: d.note }) : null,
            ),
            el('span', { class: 'doc-row__meta' },
              el('span', { class: 'doc-row__size', text: fmtBytes(d.size_bytes) }),
              arrow(),
            ),
          ));
      }
      mount(wrap, ...rows);
    })();
  </script>
</body>
</html>
```

(Confirm there is exactly one `</body></html>` at the end after this edit.)

- [ ] **Step 3: Sanity-check it loads and unauth redirects**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8765/documents.html`
Expected: `200`.
Then with Playwright, navigate unauthenticated → confirm `auth-guard.js` redirects away (not still on `/documents.html`).

- [ ] **Step 4: Signed-in resident/admin walkthrough**

While signed in: the page shows all 7 documents in order 0–6 with correct titles, badges, sizes, and notes; clicking one downloads the file with its original filename. Confirm the type badges read PDF/XLSX and sizes match the old page (665 KB, 158 KB, 5.9 MB, 227 KB, 4.2 MB, 11 KB, 65 KB).

- [ ] **Step 5: Commit**

```bash
git add documents.html
git commit -m "Documents: render dynamically from DB with signed-URL downloads"
```

---

### Task 6: Admin dashboard "Documents" tile

**Files:**
- Modify: `admin/index.html` (the `counts(...)` batch and the `mount(tiles, …)` list)

- [ ] **Step 1: Add the count to the Promise.all batch**

In `admin/index.html`, change the destructuring + `Promise.all` block (currently 8 counts) to include documents. Replace:

```js
      const [
        residentsCount, pendingCount, postsCount, draftsCount,
        eventsCount, providersCount, bulletinsCount, rosterCount,
      ] = await Promise.all([
        counts('profiles', { status: 'approved' }),
        counts('profiles', { status: 'pending' }),
        counts('news_posts', { published: true }),
        counts('news_posts', { published: false }),
        counts('events'),
        counts('providers'),
        counts('bulletins'),
        counts('residents'),
      ]);
```

with:

```js
      const [
        residentsCount, pendingCount, postsCount, draftsCount,
        eventsCount, providersCount, bulletinsCount, rosterCount,
        documentsCount,
      ] = await Promise.all([
        counts('profiles', { status: 'approved' }),
        counts('profiles', { status: 'pending' }),
        counts('news_posts', { published: true }),
        counts('news_posts', { published: false }),
        counts('events'),
        counts('providers'),
        counts('bulletins'),
        counts('residents'),
        counts('documents'),
      ]);
```

- [ ] **Step 2: Add the tile**

In the same file, inside the `mount(tiles, …)` call, add this tile right after the Providers tile (so it sits near the other content tiles):

```js
        tile(documentsCount, 'Documents',
             'Upload or remove building PDFs and files.',
             '/admin/documents.html'),
```

- [ ] **Step 3: Verify**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8765/admin/index.html`
Expected: `200`.
Signed-in admin: the dashboard shows a "Documents" tile with count `7`, linking to `/admin/documents.html`.

- [ ] **Step 4: Commit**

```bash
git add admin/index.html
git commit -m "Admin: add Documents tile to dashboard"
```

---

### Task 7: Cutover — remove the static files

**Files:**
- Remove: the 7 files under `docs/` (the document files only — NOT `docs/superpowers/**`).

- [ ] **Step 1: Confirm nothing still references the static paths**

Run:
```bash
cd /Users/amir/WORX/1400Sweetzer
grep -rn "docs/articles-of-incorporation\|docs/bylaws-2007\|docs/ccrs-2007\|docs/rules-regulations-fines-2020\|docs/condominium-plan-1990\|docs/building-upgrades\|docs/actuator-replacement" --include='*.html' .
```
Expected: **no matches** (Task 5 already removed the hardcoded list).

- [ ] **Step 2: Remove the files**

Run:
```bash
git rm docs/articles-of-incorporation.pdf docs/bylaws-2007.pdf docs/ccrs-2007.pdf \
       docs/rules-regulations-fines-2020.pdf docs/condominium-plan-1990.pdf \
       docs/building-upgrades.xlsx docs/actuator-replacement.pdf
```
Expected: 7 files staged for deletion. (`docs/superpowers/` is untouched — verify with `git status`.)

- [ ] **Step 3: Verify the live library still works from storage**

Signed-in walkthrough: `documents.html` still lists all 7 and downloads succeed (now served from the bucket, not `/docs/`). Optionally confirm the old static URL 404s after deploy: `curl -s -o /dev/null -w "%{http_code}\n" https://1400nsweetzer.com/docs/bylaws-2007.pdf` → `404`.

- [ ] **Step 4: Commit and push**

```bash
git commit -m "Documents: remove static files now served from storage"
git push origin main
```

---

## Self-review

**Spec coverage:**
- Private bucket + signed URLs → Task 2 (bucket), Task 5 (`createSignedUrl … { download }`). ✓
- `documents` table + RLS (residents read, admins write) → Task 1. ✓
- Storage object policies → Task 2. ✓
- Admin CRUD page (file, title, note, sort; add/edit/replace/delete; orphan cleanup) → Task 4. ✓
- Public page dynamic + same `.doc-row` UI → Task 5. ✓
- Admin dashboard tile → Task 6. ✓
- Migrate the 7 files preserving order/titles, exact sizes → Task 3. ✓
- Remove static files at cutover → Task 7. ✓
- Allowed types (pdf/xlsx/xls/docx/jpg/png) → Task 2 bucket + Task 4 `accept`. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete; exact paths and commands given. ✓

**Type/name consistency:** `BUCKET='documents'`, `fmtBytes`, `badge`, `storage_path`/`file_name`/`size_bytes`/`sort_order` used identically across Task 4 and Task 5; table/policy names match between Task 1 and the verification queries. ✓

**Known constraint (called out, not a gap):** the authed pages can't be fully exercised without a signed-in session, so Tasks 4–7 include explicit signed-in walkthroughs alongside the automated SQL/RLS checks — consistent with this project's testing convention.
