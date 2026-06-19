# Reliable, visible resident-news email — design

**Date:** 2026-06-19
**Status:** approved (design)

## Problem

Geoffrey published the "Insurance" notice on 2026-06-18. It shows on the cover
page (`published = true`, `email_residents = true`), but **no email was ever
sent** — the Resend log has zero "Insurance" messages, while the prior "Elevator
maintenance" post (same code, 3 days earlier) emailed all 27 residents, all
delivered. The domain has a clean delivery record (100/100 `delivered`).

Root cause: the email send is **fired from the browser, once, after publish**,
with **no retry, no server-side guarantee, and no record**. The relevant client
logic (`admin/news-edit.html`):

```js
const willEmail = publish && emailEl.checked && !wasPublishedBefore;
// ... after save:
if (willEmail && currentId) await sendEmail(currentId);
```

If the tab is closed, the network blips, or the post was already published once,
the post is published but the email silently never goes out. There is no record
of success/failure anywhere, so the failure is invisible.

## Goals

1. A publish can **never** silently go out without its email — remove the
   browser from the critical path.
2. Email status is a **fact in the database**, visible in the admin UI.
3. Failures are **recoverable** with a one-click Re-send.
4. Re-send the stuck "Insurance" notice to all 27 residents using production code.

Non-goals: changing the email template/content; per-recipient delivery tracking
(Resend already has that); digest/scheduling.

## Architecture

### 1. Source of truth — new columns on `news_posts`

| column             | type          | meaning                                  |
|--------------------|---------------|------------------------------------------|
| `email_sent_at`    | `timestamptz` | when the notice email went out (null = never) |
| `email_sent_count` | `int`         | number of recipients on the last send    |
| `email_send_error` | `text`        | last failure reason, if any              |

`email_sent_at IS NULL` is the idempotency key.

### 2. Server-side trigger — Supabase Database Webhook

Reuses the existing pattern from `notify_admin_of_signup` (DB webhook +
`X-Webhook-Secret` header). A webhook on `news_posts` **INSERT and UPDATE** POSTs
the standard webhook payload (`record` / `old_record`) to the `send_news_email`
function with header `X-Webhook-Secret: <NEWS_WEBHOOK_SECRET>`.

Defined as a **migration** using `supabase_functions.http_request(...)` (the same
trigger the dashboard generates) so it is version-controlled and reproducible.
The webhook fires on every row change; the function decides whether to send.

### 3. `send_news_email` changes

- **Dual auth** (keeps `--no-verify-jwt`):
  - admin JWT (existing path) — used by the Re-send button, *or*
  - `X-Webhook-Secret` matching `NEWS_WEBHOOK_SECRET` — used by the trigger.
  - Neither → 401.
- **Send guard:** re-read the post from the DB (don't trust the payload) and
  send only if `published = true` AND `email_residents = true` AND
  (`email_sent_at IS NULL` OR `force = true`).
- **Record outcome:** on Resend success, `UPDATE news_posts SET
  email_sent_at = now(), email_sent_count = N, email_send_error = NULL`. On
  failure, set `email_send_error` and leave `email_sent_at` null (stays
  retryable).
- **New `force: true` param** lets the Re-send button re-send an already-sent post.
- New secret `NEWS_WEBHOOK_SECRET` (Supabase function secret; also embedded in
  the trigger args). `x-webhook-secret` added to CORS allowed headers.

### 4. Admin UI

`/admin/news.html` (list) and `/admin/news-edit.html` (editor):

- Per-post email status badge:
  - `✓ Emailed 27 · Jun 15`
  - `Not emailed yet`
  - `⚠ Send failed — [Re-send]`
- **Re-send** button → calls `send_news_email` with admin JWT and
  `{ post_id, force: true }`.
- **Remove the client-side send from the publish flow.** The toggle only sets
  `email_residents`. After publish, the page polls `email_sent_at` for a few
  seconds to confirm "Emailed N residents ✓"; the trigger owns delivery either way.

## Data flow

```
publish (browser writes row: published=true, email_residents=true)
   │
   ▼
DB webhook on news_posts (server-side, guaranteed)
   │  POST {record, old_record}  + X-Webhook-Secret
   ▼
send_news_email
   │  re-reads post; if published && email_residents && (email_sent_at null || force):
   ▼
Resend batch → 27 residents
   │
   ▼
UPDATE news_posts SET email_sent_at, email_sent_count   ← idempotency + visibility
```

## Error handling & edge cases

- **Tab closed / network blip:** irrelevant — the trigger runs server-side.
- **Edit after send:** `email_sent_at` is set → guard skips → no re-send (matches
  current intent).
- **Double publish / rapid edits:** webhook may fire multiple times; the
  `email_sent_at` guard + re-read makes the send happen at most once.
- **Resend failure:** recorded in `email_send_error`, `email_sent_at` stays null,
  UI shows "Send failed — [Re-send]", and any later edit re-fires the trigger.
- **Abuse of public endpoint:** rejected without the secret or an admin JWT.
- **`pg_net`/webhook is fire-and-forget:** the function records its own outcome to
  the row; the UI is the feedback channel, not the webhook response.

## Immediate re-send (the stuck Insurance post)

After deploy, clear nothing / call `send_news_email` with the webhook secret and
`{ post_id: <insurance>, force: true }` (server-side, no browser). This uses
production code, mails the real notice to all 27, and is the happy-path
integration test. **This will email all 27 residents** — intended.

## Testing

1. **Happy path = the Insurance re-send:** 27 sent, `email_sent_at`/`count`
   stamped, Resend log shows 27 new "Insurance" messages.
2. **Idempotency:** edit the Insurance post (e.g. fix a typo) → webhook fires →
   no new emails (guard), `email_sent_at` unchanged.
3. **Auth:** a POST with neither secret nor admin JWT → 401; the public anon key
   alone cannot trigger a send.
4. **New post happy path** (optional, only if a safe test recipient set is
   arranged): publish a post → trigger fires → emailed without any browser action.

## Migrations & deploy checklist

- Migration: add 3 columns to `news_posts`.
- Migration: create the `news_posts` webhook trigger via
  `supabase_functions.http_request`.
- `supabase secrets set NEWS_WEBHOOK_SECRET=…`.
- Deploy `send_news_email` **with `--no-verify-jwt`** (project rule).
- Bump `?v=` cache-busters on edited admin pages (project rule).
