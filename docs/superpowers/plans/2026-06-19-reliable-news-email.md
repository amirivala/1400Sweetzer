# Reliable Resident-News Email — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the resident-news email fire reliably server-side (never lost when a browser tab closes), record send status on each post for visibility, add a Re-send button, and re-send the stuck "Insurance" notice to all 27 residents.

**Architecture:** A Postgres `AFTER INSERT OR UPDATE` trigger on `news_posts` calls the `send_news_email` Edge Function over `pg_net` whenever a post is published with the email toggle on and hasn't been emailed yet. The function gains a shared-secret auth path (for the trigger) alongside the existing admin-JWT path (for the Re-send button), re-checks send conditions against the DB, sends via Resend, and stamps `email_sent_at` / `email_sent_count` back on the row. The admin UI reads those columns to show status and offer Re-send; the fragile client-side send is removed.

**Tech Stack:** Supabase Postgres (triggers, `pg_net`, Vault), Supabase Edge Functions (Deno/TypeScript), Resend batch API, static HTML admin pages with `@supabase/supabase-js` UMD.

## Global Constraints

- **Every Edge Function deploys with `--no-verify-jwt`** — this project issues ES256 session tokens the gateway rejects; all auth is done in-function. (memory: supabase_edge_function_auth)
- **Project ref:** `nvazngprbjccclzmgphg`. Function base URL: `https://nvazngprbjccclzmgphg.supabase.co/functions/v1`.
- **Public anon key** (for invoking functions from curl): `sb_publishable_Dm9QjMYym_e0kwzMo4v3fA_WPangWJB`.
- **Never commit secrets to git.** The webhook shared secret lives in Supabase Vault (for the trigger) and as a function secret `NEWS_WEBHOOK_SECRET` (for the function); the migration references it by name only.
- **After editing `assets/*.css` or `assets/page-shell.js`, bump the `?v=N` query on every page that loads it.** Editing an HTML page's own inline script needs no bump. (memory: css_cache_buster)
- **Insurance post id:** `fb0426c5-09bc-4972-9aa0-8ac40ac2afce`.
- **Migrations** are sequential under `supabase/migrations/`; latest is `00023_*`. New ones are `00024_*`, `00025_*`.
- Run remote SQL with `supabase db query --linked "<sql>"`; push migrations with `supabase db push`.

---

### Task 1: Add email-status columns to `news_posts`

**Files:**
- Create: `supabase/migrations/00024_news_email_status.sql`

**Interfaces:**
- Produces: columns `news_posts.email_sent_at timestamptz`, `news_posts.email_sent_count int`, `news_posts.email_send_error text` (all nullable, default null).

- [ ] **Step 1: Write the migration**

```sql
-- 00024_news_email_status.sql
-- Records the outcome of the resident-news email for each post, so a
-- publish can no longer silently go out with no email and admins can see
-- exactly what was sent (and re-send on failure).

alter table public.news_posts
  add column if not exists email_sent_at    timestamptz,
  add column if not exists email_sent_count integer,
  add column if not exists email_send_error text;

comment on column public.news_posts.email_sent_at is
  'When the resident-news email for this post was sent (null = never). Idempotency key for the send trigger.';
comment on column public.news_posts.email_sent_count is
  'Number of recipients on the most recent successful send.';
comment on column public.news_posts.email_send_error is
  'Last send failure reason, if any (null when the last attempt succeeded).';
```

- [ ] **Step 2: Push the migration**

Run: `supabase db push`
Expected: applies `00024_news_email_status.sql` without error.

- [ ] **Step 3: Verify the columns exist**

Run:
```bash
supabase db query --linked "select column_name, data_type from information_schema.columns where table_schema='public' and table_name='news_posts' and column_name in ('email_sent_at','email_sent_count','email_send_error') order by column_name;"
```
Expected: three rows — `email_send_error|text`, `email_sent_at|timestamp with time zone`, `email_sent_count|integer`.

- [ ] **Step 4: Backfill the already-delivered Elevator post so it shows correct status**

The "Elevator maintenance" post was emailed to 27 residents on 2026-06-15 (confirmed in Resend). Stamp it so the UI doesn't show it as "Not emailed yet" and the trigger never re-sends it.

Run:
```bash
supabase db query --linked "update public.news_posts set email_sent_at = '2026-06-15 18:26:57+00', email_sent_count = 27 where title = 'Elevator maintenance' and email_sent_at is null;"
```
Expected: `UPDATE 1`. (Leave the Insurance post's `email_sent_at` null — it is intentionally re-sent in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00024_news_email_status.sql
git commit -m "DB: add email send-status columns to news_posts"
```

---

### Task 2: Generate the webhook shared secret (Vault + function env)

**Files:** none (operational; secret value is never written to the repo).

**Interfaces:**
- Produces: Vault secret named `news_webhook_secret` and function secret `NEWS_WEBHOOK_SECRET`, both holding the **same** value. Task 3 (function) reads `NEWS_WEBHOOK_SECRET`; Task 4 (trigger) reads `news_webhook_secret`.

- [ ] **Step 1: Generate a random secret and store it in both places**

Run (generates once, stores in Vault and as a function secret; prints nothing sensitive to logs beyond what's needed):
```bash
SECRET=$(openssl rand -hex 32)
supabase db query --linked "select vault.create_secret('$SECRET', 'news_webhook_secret', 'Shared secret for the news_posts -> send_news_email webhook');"
supabase secrets set NEWS_WEBHOOK_SECRET="$SECRET" --project-ref nvazngprbjccclzmgphg
echo "stored"
```
Expected: the `vault.create_secret` call returns a uuid; `supabase secrets set` reports the secret was set; prints `stored`.

- [ ] **Step 2: Verify both exist (names only, not values)**

Run:
```bash
supabase db query --linked "select name from vault.secrets where name = 'news_webhook_secret';"
```
Expected: one row, `news_webhook_secret`.

(No commit — nothing in the repo changed.)

---

### Task 3: Rework `send_news_email` (dual auth, send guard, record outcome, force)

**Files:**
- Modify: `supabase/functions/send_news_email/index.ts`

**Interfaces:**
- Consumes: `news_posts.email_sent_at/email_sent_count/email_send_error` (Task 1); env `NEWS_WEBHOOK_SECRET` (Task 2).
- Produces: a function that accepts `POST {post_id: string, force?: boolean}`, authorized by **either** an admin JWT in `Authorization` **or** a matching `X-Webhook-Secret` header. Sends only when the post is `published && email_residents && (email_sent_at IS NULL || force)`. Returns JSON `{ok, sent, skipped?, reason?}`. Stamps the row on success; records `email_send_error` on failure.

- [ ] **Step 1: Replace the auth/CORS/handler logic.** Keep the existing `buildEmail()` function and the env constants block at the top unchanged, but (a) add the new secret constant, (b) add `x-webhook-secret` to CORS headers, and (c) replace the `Deno.serve(...)` handler body. The full new handler:

Add near the other env constants (after `SITE_URL`):
```ts
const WEBHOOK_SECRET = Deno.env.get('NEWS_WEBHOOK_SECRET') || '';
```

Change the CORS headers `Access-Control-Allow-Headers` line to include the webhook header:
```ts
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
```

Replace the entire `Deno.serve(async (req) => { ... })` block with:
```ts
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // --- Auth: trigger (shared secret) OR admin (session JWT) ---
  const providedSecret = req.headers.get('X-Webhook-Secret') || '';
  const bySecret = WEBHOOK_SECRET.length > 0 && providedSecret === WEBHOOK_SECRET;

  if (!bySecret) {
    const authHeader = req.headers.get('Authorization') || '';
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders });
    }
    const { data: callerProfile } = await admin
      .from('profiles').select('role, status').eq('id', user.id).single();
    if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
      return new Response('Forbidden', { status: 403, headers: corsHeaders });
    }
  }

  // --- Payload ---
  let body: { post_id?: string; force?: boolean };
  try { body = await req.json(); }
  catch { return new Response('Bad JSON', { status: 400, headers: corsHeaders }); }
  const postId = body.post_id;
  const force = body.force === true;
  if (!postId) return new Response('Missing post_id', { status: 400, headers: corsHeaders });

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  // --- Fetch post + re-check send conditions against the DB ---
  const { data: post, error: postErr } = await admin
    .from('news_posts')
    .select('id, title, body, cover_image_url, published, email_residents, email_sent_at')
    .eq('id', postId).single();
  if (postErr || !post) return json({ ok: false, error: 'Post not found' }, 404);

  if (!post.published)       return json({ ok: true, sent: 0, skipped: true, reason: 'not_published' });
  if (!post.email_residents) return json({ ok: true, sent: 0, skipped: true, reason: 'email_off' });
  if (post.email_sent_at && !force) {
    return json({ ok: true, sent: 0, skipped: true, reason: 'already_sent' });
  }

  // --- Recipients: approved, opted-in residents with an email ---
  const { data: profiles } = await admin
    .from('profiles').select('id').eq('status', 'approved').eq('email_news_optin', true);
  const optInIds = new Set((profiles || []).map((p) => p.id));
  const { data: usersPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const recipients = (usersPage?.users || [])
    .filter((u) => optInIds.has(u.id) && !!u.email)
    .map((u) => u.email!);

  if (recipients.length === 0) {
    return json({ ok: true, sent: 0, skipped: true, reason: 'no_recipients' });
  }

  // --- Send via Resend batch ---
  const { html, text } = buildEmail(post);
  const fromHeader = `${FROM_NAME} <${FROM_EMAIL}>`;
  const batch = recipients.map((to) => ({
    from: fromHeader, reply_to: REPLY_TO, to, subject: post.title, html, text,
  }));

  let resendOk = false;
  let resendParsed: unknown = null;
  try {
    const resendRes = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    const resendBody = await resendRes.text();
    try { resendParsed = JSON.parse(resendBody); } catch { resendParsed = resendBody; }
    resendOk = resendRes.ok;
  } catch (e) {
    resendParsed = `fetch error: ${(e as Error)?.message || e}`;
  }

  // --- Record outcome on the post ---
  if (resendOk) {
    await admin.from('news_posts').update({
      email_sent_at: new Date().toISOString(),
      email_sent_count: recipients.length,
      email_send_error: null,
    }).eq('id', postId);
    return json({ ok: true, sent: recipients.length, resend: resendParsed });
  } else {
    const errText = (typeof resendParsed === 'string' ? resendParsed : JSON.stringify(resendParsed)).slice(0, 500);
    await admin.from('news_posts').update({ email_send_error: errText }).eq('id', postId);
    return json({ ok: false, sent: 0, error: errText, resend: resendParsed }, 502);
  }
});
```

- [ ] **Step 2: Deploy with `--no-verify-jwt`**

Run: `supabase functions deploy send_news_email --no-verify-jwt --project-ref nvazngprbjccclzmgphg`
Expected: `Deployed Functions on project nvazngprbjccclzmgphg: send_news_email`.

- [ ] **Step 3: Verify unauthorized calls are rejected (safe — sends nothing)**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://nvazngprbjccclzmgphg.supabase.co/functions/v1/send_news_email" \
  -H "apikey: sb_publishable_Dm9QjMYym_e0kwzMo4v3fA_WPangWJB" \
  -H "Authorization: Bearer faketoken.abc.def" \
  -H "Content-Type: application/json" -d '{"post_id":"fb0426c5-09bc-4972-9aa0-8ac40ac2afce"}'
```
Expected: `401` (no valid JWT, no secret → rejected before any send).

- [ ] **Step 4: Verify the wrong secret is also rejected**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://nvazngprbjccclzmgphg.supabase.co/functions/v1/send_news_email" \
  -H "apikey: sb_publishable_Dm9QjMYym_e0kwzMo4v3fA_WPangWJB" \
  -H "X-Webhook-Secret: wrong-secret" \
  -H "Content-Type: application/json" -d '{"post_id":"fb0426c5-09bc-4972-9aa0-8ac40ac2afce"}'
```
Expected: `401`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/send_news_email/index.ts
git commit -m "send_news_email: dual auth (secret|admin), send guard, record outcome, force"
```

---

### Task 4: Create the server-side send trigger

**Files:**
- Create: `supabase/migrations/00025_news_email_webhook.sql`

**Interfaces:**
- Consumes: Vault secret `news_webhook_secret` (Task 2); deployed `send_news_email` (Task 3).
- Produces: trigger `news_email_on_publish` on `public.news_posts` that POSTs `{post_id}` with `X-Webhook-Secret` to the function whenever `published && email_residents && email_sent_at IS NULL`.

- [ ] **Step 1: Write the migration**

```sql
-- 00025_news_email_webhook.sql
-- Server-side guarantee that a published post with the email toggle on gets
-- emailed exactly once. Replaces the old best-effort, browser-fired send.
-- The shared secret is read from Vault at runtime so it never lives in git.

create extension if not exists pg_net with schema extensions;

create or replace function public.tg_news_email_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_secret text;
begin
  if new.published and new.email_residents and new.email_sent_at is null then
    select decrypted_secret into v_secret
      from vault.decrypted_secrets
      where name = 'news_webhook_secret'
      limit 1;

    perform net.http_post(
      url     := 'https://nvazngprbjccclzmgphg.supabase.co/functions/v1/send_news_email',
      headers := jsonb_build_object(
                   'Content-Type',    'application/json',
                   'X-Webhook-Secret', coalesce(v_secret, '')
                 ),
      body    := jsonb_build_object('post_id', new.id::text),
      timeout_milliseconds := 8000
    );
  end if;
  return new;
end;
$$;

drop trigger if exists news_email_on_publish on public.news_posts;
create trigger news_email_on_publish
  after insert or update on public.news_posts
  for each row execute function public.tg_news_email_notify();
```

- [ ] **Step 2: Push the migration**

Run: `supabase db push`
Expected: applies `00025_news_email_webhook.sql` without error.

- [ ] **Step 3: Verify the trigger exists**

Run:
```bash
supabase db query --linked "select tgname from pg_trigger where tgrelid = 'public.news_posts'::regclass and not tgisinternal;"
```
Expected: includes `news_email_on_publish`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00025_news_email_webhook.sql
git commit -m "DB: server-side trigger to email residents on publish (pg_net + vault secret)"
```

---

### Task 5: Re-send the Insurance notice through the trigger (integration test)

**Files:** none (operational verification of Tasks 1–4).

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: 27 "Insurance" emails delivered; `email_sent_at`/`email_sent_count` stamped on the post; idempotency confirmed.

- [ ] **Step 1: Confirm the Insurance post is still unsent**

Run:
```bash
supabase db query --linked "select title, published, email_residents, email_sent_at, email_sent_count from news_posts where id = 'fb0426c5-09bc-4972-9aa0-8ac40ac2afce';"
```
Expected: `published=true`, `email_residents=true`, `email_sent_at=null`.

- [ ] **Step 2: Fire the trigger by touching the row (full production path)**

A no-op `UPDATE` fires the `AFTER UPDATE` trigger, which calls the function over `pg_net`. This is intentional and **will email all 27 residents the real Insurance notice**.

Run:
```bash
supabase db query --linked "update public.news_posts set title = title where id = 'fb0426c5-09bc-4972-9aa0-8ac40ac2afce';"
```
Expected: `UPDATE 1`.

- [ ] **Step 3: Wait ~15s, then confirm the post was stamped**

Run (after a short wait for the async `pg_net` call + Resend):
```bash
supabase db query --linked "select email_sent_at, email_sent_count, email_send_error from news_posts where id = 'fb0426c5-09bc-4972-9aa0-8ac40ac2afce';"
```
Expected: `email_sent_at` is set (now), `email_sent_count = 27`, `email_send_error = null`.
If `email_sent_at` is still null after ~30s, inspect `pg_net` results:
```bash
supabase db query --linked "select status_code, content::text from net._http_response order by created desc limit 3;"
```
(A 401 means the Vault secret ≠ function secret; a 200 with `skipped` means a guard tripped.)

- [ ] **Step 4: Confirm 27 Insurance emails in Resend**

Verify in the Resend dashboard (Emails log) that ~27 messages with subject **"Insurance"** were just sent and show `delivered`. (Geoffrey @ Unit 403 and Catharine @ Unit 406 should both appear.)

- [ ] **Step 5: Idempotency — a second touch must NOT re-send**

Run:
```bash
supabase db query --linked "update public.news_posts set title = title where id = 'fb0426c5-09bc-4972-9aa0-8ac40ac2afce';"
```
Wait ~15s, then confirm no new Resend "Insurance" emails appear and `email_sent_count` is unchanged. (The trigger condition `email_sent_at IS NULL` is now false, so `net.http_post` is never called.)

(No commit — operational.)

---

### Task 6: Admin UI — status badge, Re-send button, remove client send

**Files:**
- Modify: `admin/news.html` (post list — add status + Re-send)
- Modify: `admin/news-edit.html` (editor — remove client send, show status, poll after publish)

**Interfaces:**
- Consumes: `news_posts.email_sent_at/email_sent_count/email_send_error`; the deployed `send_news_email` (admin-JWT path, `{post_id, force:true}`).
- Produces: visible per-post email status and a working Re-send button; publish no longer depends on a client-side send.

- [ ] **Step 1: Read both files to anchor the edits**

Run: open `admin/news.html` and `admin/news-edit.html`. Note in `news.html` the query that lists posts and the row/card render; in `news-edit.html` the `select(...)` on load, the `sendEmail()` function, the `willEmail` logic, and the `save()` flow.

- [ ] **Step 2: `admin/news.html` — select the status columns**

In the posts query, add the three columns to the `.select(...)` list (e.g. change `select('id, title, published, published_at')` to include `, email_sent_at, email_sent_count, email_send_error`). Match the existing string exactly before editing.

- [ ] **Step 3: `admin/news.html` — render a status line + Re-send button per published post**

Where each post row/card is built, add a status element. Use the existing `el(...)` DOM helper (from `/assets/dom.js`). For a published post, render one of:
- sent: `✓ Emailed {email_sent_count} · {fmt.shortDate(email_sent_at)}`
- error: `⚠ Email failed` + a `Re-send` button
- not yet: `Not emailed yet` + a `Re-send` button

Re-send button handler (uses the current admin session token):
```js
async function resend(postId, btn) {
  btn.disabled = true; btn.textContent = 'Sending…';
  const { data: { session } } = await window.sb.auth.getSession();
  try {
    const res = await fetch(`${window.ENV.SUPABASE_URL}/functions/v1/send_news_email`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ post_id: postId, force: true }),
    });
    const r = await res.json();
    btn.textContent = res.ok ? `Emailed ${r.sent}` : 'Failed — retry';
    if (res.ok) location.reload();
  } catch (e) {
    btn.textContent = 'Failed — retry'; btn.disabled = false;
  }
}
```

- [ ] **Step 4: `admin/news-edit.html` — load the status column**

In the editing `select('id, title, body, cover_image_url, published, email_residents, published_at')`, append `, email_sent_at, email_sent_count`. Capture `email_sent_at` into a variable for display.

- [ ] **Step 5: `admin/news-edit.html` — remove the fragile client-side send**

Delete the `sendEmail()` function and the `willEmail` computation, and remove the `if (willEmail && currentId) await sendEmail(currentId);` line from `save()`. The toggle now only persists `email_residents` (already in the payload). After a successful publish, set status to `Published ✓ · emailing residents…` and start a short poll:

```js
// After publish succeeds (post is now published with email_residents on),
// the DB trigger sends the email. Poll the row briefly to confirm.
const pollSent = async (id) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await window.sb
      .from('news_posts').select('email_sent_at, email_sent_count').eq('id', id).single();
    if (data?.email_sent_at) {
      statusEl.textContent = `Published ✓ · emailed ${data.email_sent_count} residents`;
      return;
    }
  }
  statusEl.textContent = 'Published ✓ · email is sending (check the post list for status)';
};
```
Call `pollSent(currentId)` after a publish that has `email_residents` on and was not already sent. For an edit to an already-published post, just show `Saved ✓` (no email — matches the guard).

- [ ] **Step 6: Cache-buster check**

These edits are to the pages' own inline `<script>` blocks and the page HTML — **not** to `assets/styles.css` or `assets/page-shell.js` — so no `?v=` bump is required. Confirm you did not edit those shared assets.

- [ ] **Step 7: Manual verification in the browser**

Log in as an admin, open `/admin/news.html`. Expected: "Insurance" and "Elevator maintenance" both show `✓ Emailed 27 · <date>`. Click Re-send on a post → status updates to `Emailed N` (and, if you actually want to avoid mailing during this check, test Re-send only when you intend a real send, since `force:true` mails everyone).

- [ ] **Step 8: Commit**

```bash
git add admin/news.html admin/news-edit.html
git commit -m "Admin news: show email status + Re-send button; drop client-side send (trigger owns it)"
```

---

## Self-Review

**Spec coverage:**
- New columns → Task 1. ✓
- Server-side trigger (DB webhook pattern) → Task 4 (uses pg_net + Vault secret; equivalent to the `supabase_functions.http_request` webhook, kept secret-free). ✓
- Dual auth / send guard / record outcome / force → Task 3. ✓
- Shared secret in Vault + function env → Task 2. ✓
- Admin UI status + Re-send + remove client send + poll → Task 6. ✓
- Immediate Insurance re-send + idempotency + auth tests → Tasks 5 and 3. ✓
- `--no-verify-jwt`, cache-buster rule → Global Constraints + Task 3 Step 2 + Task 6 Step 6. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; secret values are generated at runtime (Task 2), not placeholders to fill.

**Type consistency:** Function accepts `{post_id, force}` (Task 3); trigger sends `{post_id}` (Task 4); UI sends `{post_id, force:true}` (Task 6). Response shape `{ok, sent, skipped?, reason?, error?}` consumed by UI in Task 6. Columns `email_sent_at/email_sent_count/email_send_error` named identically across Tasks 1, 3, 4, 6.

**Note on Task 5:** The Insurance re-send is deliberately destructive (mails 27 real residents) and is the approved Task #1 outcome — not a dry run.
