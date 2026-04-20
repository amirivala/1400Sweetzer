# Signup & Approval Emails — Design

**Date:** 2026-04-20
**Status:** Approved (ready for implementation planning)

## Summary

Add two new transactional emails to the Sunset Penthouse resident portal so that:

1. **Admins get notified when a new resident requests access.**
2. **New residents get a welcome email when an admin approves them.**

Both emails reuse the visual chrome of the existing magic-link email
(`supabase/email-templates/magic-link.html`) and the send pipeline of the
existing `send_news_email` edge function, so the brand look is identical to
what residents already see.

Rejections (`status='removed'`) are silent — no email is sent.

## Motivation

Today the signup → approval loop is invisible on both sides:

- A resident signs up, gets a magic-link email, clicks it, lands confirmed,
  and then waits in the `pending` status with no feedback.
- Admins only discover pending signups by opening `/admin/residents.html` and
  looking at the list.

This adds two tight feedback loops: admins learn immediately when someone
wants in, and approved residents learn immediately that they're in.

## Scope

### In scope

- New edge function: `notify_admin_of_signup`.
- New edge function: `send_welcome_email`.
- Supabase Database Webhook wiring `profiles` INSERT (where `status='pending'`)
  → `notify_admin_of_signup`.
- A small change in `/admin/residents.html` to invoke `send_welcome_email`
  when the "Approve" button flips a `pending` row to `approved`.
- Shared email-chrome helper (or duplicated HTML template) so both new
  functions and the existing `send_news_email` produce the same visual
  design.
- One new Supabase secret: `ADMIN_NOTIFY_EMAIL` (optional; shared board
  inbox).

### Out of scope

- Rejection emails (silent, per design decision).
- One-click approve/reject links inside the admin notification email (review
  stays in `/admin/residents.html`).
- Magic-link auto-login from inside the welcome email (welcome is a status
  notification, not a login link).
- Any redesign of the existing email look.
- Any change to `send_news_email` beyond optionally extracting a shared
  template helper.

## Design

### Two new edge functions

Both live under `supabase/functions/` and mirror the structure of the
existing `send_news_email/index.ts`.

#### `notify_admin_of_signup`

**Triggered by:** Supabase Database Webhook on `INSERT` into `profiles`
where `status='pending'`. The webhook sends the new row as JSON to the
function URL with a signed verification header.

**Behavior:**

1. Verify the webhook signature (Supabase provides a shared secret).
2. Look up the inserted profile's email from `auth.users` via service role
   (`auth.admin.getUserById(new.id)`).
3. Build the recipient list:
   - All approved admins: `profiles` where `role='admin' AND
     status='approved'`, then resolve emails via `auth.admin.listUsers`.
   - Plus `ADMIN_NOTIFY_EMAIL` if set.
   - Deduplicate (case-insensitive) so the shared inbox doesn't double up
     with an admin who uses the same address.
4. Send one Resend batch request with one `to` per recipient.

**Email content** (kicker: `NEW RESIDENT REQUEST`):

- Title: "A new resident just requested access."
- Body: shows full name, unit, email, phone, requested-on date.
- CTA: **"Review in admin →"** → `${SITE_URL}/admin/residents.html`.
- Footer reason line: "You're receiving this because you're a board member
  at 1400 N Sweetzer Ave."

#### `send_welcome_email`

**Triggered by:** POST from `/admin/residents.html` after the Approve
button successfully flips a profile from `pending` to `approved`.

**Behavior:**

1. Verify caller is an approved admin (same pattern as `send_news_email`:
   user client reads JWT, service-role client re-queries `profiles` for
   `role` and `status`).
2. Read `{ profile_id }` from the request body.
3. Look up the target profile's email via
   `auth.admin.getUserById(profile_id)` and full name / unit from the
   `profiles` row.
4. Send a single Resend email.

**Email content** (kicker: `WELCOME`):

- Title: "You're in."
- Body: "Welcome to Sunset Penthouse — the private resident portal for
  1400 N Sweetzer. A board member just approved your account. Inside
  you'll find building news, the events calendar, the resident directory,
  and a list of trusted providers."
- CTA: **"Sign in →"** → `${SITE_URL}/auth/signin.html`.
- Footer: address strip + wordmark (no opt-out link — this is a one-shot
  transactional email).

### Shared email chrome

To keep the three emails visually identical (magic-link, news notice,
signup-admin-notice, welcome), extract the repeated outer HTML into a
small helper so each function only supplies:

- `kicker` — small all-caps label under the brand name
- `title` — italic Fraunces headline
- `bodyHtml` — the main paragraph(s)
- `cta` — `{ href, label }`
- `footerHtml` — reason line / address / opt-out (optional)

Recommendation: put the shared helper at
`supabase/functions/_shared/email_layout.ts` so both new functions and a
future refactor of `send_news_email` can import it. (If the refactor of
`send_news_email` is out of scope for the first pass, duplicate the chrome
in the two new functions for now and plan the extraction as a follow-up.)

Color tokens, fonts, dark-mode block, and phone breakpoints must match the
existing magic-link template exactly.

### Admin residents page change

In `/admin/residents.html`, inside the Approve button handler, after a
successful status flip from `pending` to `approved`, fire-and-forget a call
to the welcome function:

```
supabase.functions
  .invoke('send_welcome_email', { body: { profile_id: r.id } })
  .catch(e => toast(`Approved — welcome email didn't send: ${e.message}`));
```

The send must be guarded so it only fires when the row was `pending` *before*
the update — so restoring a `removed` resident back to `approved` does NOT
trigger a welcome email. The current code structure in `residents.html`
already separates the `pending` and `approved` branches; the call lives
inside the `pending` branch only.

`updateStatus` should be adjusted so the Approve branch can tell whether
the update succeeded before invoking the welcome function.

### Database webhook configuration

Configured in Supabase dashboard (Database → Webhooks):

- **Table:** `profiles`
- **Events:** INSERT
- **Condition:** `record.status = 'pending'` (filter in webhook definition
  if supported; otherwise filter inside the function)
- **HTTP method:** POST
- **URL:** the deployed `notify_admin_of_signup` function URL
- **Headers:** a shared-secret header verified inside the function

## Recipient & config details

**Env vars / secrets:**

- `RESEND_API_KEY` — existing
- `FROM_EMAIL` — existing (e.g. `notices@1400sweetzer.com`)
- `FROM_NAME` — existing (defaults to "Sunset Penthouse")
- `SITE_URL` — existing
- `ADMIN_NOTIFY_EMAIL` — **new**, optional; comma-separated is not
  supported in v1 (one address).
- `PROFILES_WEBHOOK_SECRET` — **new**, shared secret for the DB webhook →
  `notify_admin_of_signup`.

## Error handling

- **Webhook signature invalid:** 401 response, nothing sent, logged.
- **Resend call fails on admin notification:** logged server-side only.
  The end user's signup flow is unaffected (the webhook fires
  asynchronously).
- **Resend call fails on welcome email:** the admin sees a small toast
  ("Approved — welcome email didn't send: <message>") and the status
  change still commits. They can re-send manually if we add that later
  (out of scope for v1).
- **No admins exist yet:** notify function returns `{ sent: 0 }`; not an
  error.
- **Target profile already removed by the time welcome fires:** function
  returns 400 with a clear message; toast surfaces it.

## Edge cases

- **Re-signup after rejection:** if `handle_new_user` is extended to flip
  a `removed` profile back to `pending` on re-signup, the INSERT webhook
  does NOT fire (it's an UPDATE). For v1 we accept this as a known
  limitation; a follow-up can add an UPDATE webhook scoped to
  `removed → pending` transitions.
- **Re-approval of a previously removed resident:** no welcome email,
  because the client-side guard checks that the row was `pending` before
  the update.
- **Admin approves themselves:** impossible — self-approval UI doesn't
  exist, and admins are created by other admins.
- **Shared inbox === admin email:** deduplicated case-insensitively.

## Testing

Manual verification before merging:

1. Sign up as a fresh test email → verify admin + board inbox receive the
   notification, correctly formatted, with working "Review in admin" CTA.
2. Approve that test account in `/admin/residents.html` → verify the test
   email receives the welcome email with working "Sign in" CTA.
3. Reject a second test signup → verify NO email is sent.
4. Restore a removed resident → verify NO welcome email fires.
5. Open both emails in Apple Mail light mode, Apple Mail dark mode, Gmail
   web, Gmail iOS, Outlook (web) to confirm the chrome renders identically
   to the existing magic-link email.

## Open questions

None — all design decisions are settled per the brainstorming transcript.

## Follow-ups (explicitly out of scope for v1)

- Extract shared email chrome and refactor `send_news_email` to use it.
- UPDATE-webhook path so re-signups of rejected users still notify admins.
- Manual "re-send welcome email" button on the admin residents page.
- Rejection email (opt-in per case).
