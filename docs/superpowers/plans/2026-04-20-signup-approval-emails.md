# Signup & Approval Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two transactional emails — admin notification when a new resident requests access, and a welcome email when an admin approves a `pending` signup — both rendered in the existing Sunset Penthouse brand chrome.

**Architecture:** Two new Supabase Edge Functions under `supabase/functions/` that reuse a new shared email-layout helper. `notify_admin_of_signup` is triggered by a Supabase Database Webhook on `profiles` INSERT. `send_welcome_email` is triggered by `/admin/residents.html` right after the Approve click flips `pending → approved`. Rejections are silent.

**Tech Stack:** Supabase Edge Functions (Deno), Resend (batch email API), Supabase Database Webhooks, vanilla JS for the admin page wiring. No automated test framework in this repo — verification is manual E2E via real Resend inboxes, matching the pattern already established by `send_news_email`.

**Design spec:** `docs/superpowers/specs/2026-04-20-signup-approval-emails-design.md`

---

## File structure

**Create:**
- `supabase/functions/_shared/email_layout.ts` — shared email chrome (header, card, monogram, dark-mode block, phone breakpoints, footer wordmark). Exports a single `renderEmail({ kicker, title, bodyHtml, cta, reasonHtml }) → { html, text }` function.
- `supabase/functions/notify_admin_of_signup/index.ts` — webhook handler that emails admins + shared inbox when a new `pending` profile lands.
- `supabase/functions/send_welcome_email/index.ts` — admin-authenticated function that sends the welcome email to one newly-approved resident.

**Modify:**
- `admin/residents.html` — call `send_welcome_email` inside the Approve button handler (pending → approved only).

**Touch for config (not code):**
- Supabase Dashboard → Database → Webhooks — new webhook `profiles_insert_notify_admin`.
- Supabase secrets — new `ADMIN_NOTIFY_EMAIL` (optional) and `PROFILES_WEBHOOK_SECRET` (required).

---

## Task 1: Shared email-layout helper

**Files:**
- Create: `supabase/functions/_shared/email_layout.ts`

- [ ] **Step 1: Create the helper file**

The goal is a single source of truth for card/mast/CTA/footer markup so the three emails (magic-link, news, signup-notify, welcome) look identical. Copy the chrome from `supabase/functions/send_news_email/index.ts` verbatim so the output matches byte-for-byte, then parameterize the five slots that vary (`kicker`, `title`, `bodyHtml`, `cta`, `reasonHtml`).

Create `supabase/functions/_shared/email_layout.ts`:

```ts
// Shared email chrome for Sunset Penthouse transactional emails.
// All three templates (magic-link, resident notice, signup-notify,
// welcome) use this layout so branding stays identical.

export interface EmailCta {
  href: string;
  label: string;
}

export interface EmailInput {
  kicker: string;         // e.g. "WELCOME" or "NEW RESIDENT REQUEST"
  title: string;          // italic Fraunces headline, already plain text
  bodyHtml: string;       // pre-escaped HTML for the main paragraph block
  cta: EmailCta;          // { href, label }
  reasonHtml?: string;    // optional grey footer text, pre-escaped HTML
  previewText: string;    // inbox preview; plain text, pre-escaped
  textBody: string;       // full plain-text alternative
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderEmail(input: EmailInput): RenderedEmail {
  const { kicker, title, bodyHtml, cta, reasonHtml, previewText, textBody } = input;

  const safeHref   = escapeHtml(cta.href);
  const safeLabel  = escapeHtml(cta.label);
  const safeKicker = escapeHtml(kicker);
  const safeTitle  = escapeHtml(title);
  const safePreview = escapeHtml(previewText);

  const reasonBlock = reasonHtml
    ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
            <tr>
              <td class="sp-muted" style="color:#80715f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.65;">
                ${reasonHtml}
              </td>
            </tr>
          </table>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${safeTitle}</title>
  <!--[if mso]>
  <style>
    * { font-family: 'Segoe UI', Arial, sans-serif !important; }
    table, td { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
  </style>
  <![endif]-->
  <style>
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
    img  { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    a { text-decoration: none; }
    @media (prefers-color-scheme: dark) {
      .sp-stage  { background: #0c0a09 !important; }
      .sp-card   { background: #18130f !important; }
      .sp-ink    { color: #fbf5e9 !important; }
      .sp-body   { color: #d6c8b2 !important; }
      .sp-muted  { color: #9c8a70 !important; }
      .sp-rule   { border-color: #2a231c !important; }
      .sp-btn    { background-color: #fbf5e9 !important; }
      .sp-btn a  { color: #1c150f !important; }
      .sp-kicker { color: #e0a37a !important; }
    }
    @media only screen and (max-width: 620px) {
      .sp-stage-pad { padding: 20px 12px !important; }
      .sp-card-pad  { padding: 30px 26px !important; }
      .sp-title     { font-size: 26px !important; line-height: 1.15 !important; }
      .sp-excerpt   { font-size: 15px !important; }
    }
  </style>
</head>
<body class="sp-stage" style="margin:0;padding:0;background:#f5f0e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
    ${safePreview}
    &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;
    &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;
  </div>

  <table role="presentation" class="sp-stage" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0e6" style="background:#f5f0e6;">
    <tr><td align="center" class="sp-stage-pad" style="padding:40px 20px;">

      <table role="presentation" class="sp-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fffaf0;border-radius:22px;box-shadow:0 24px 60px rgba(28,21,15,0.10);">
        <tr><td class="sp-card-pad" style="padding:44px 44px 40px;">

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="48" style="width:48px;vertical-align:middle;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#1c150f" style="background:#1c150f;border-radius:24px;">
                  <tr>
                    <td width="48" height="48" align="center" valign="middle" class="sp-ink" style="width:48px;height:48px;color:#fbf5e9;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:500;font-size:17px;letter-spacing:0.5px;line-height:48px;">
                      SP
                    </td>
                  </tr>
                </table>
              </td>
              <td style="vertical-align:middle;padding-left:14px;">
                <div class="sp-ink" style="color:#1c150f;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:500;font-size:18px;line-height:1.15;">Sunset Penthouse</div>
                <div class="sp-kicker" style="margin-top:3px;color:#b94a2c;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.24em;text-transform:uppercase;line-height:1;">${safeKicker}</div>
              </td>
            </tr>
          </table>

          <h1 class="sp-ink sp-title" style="margin:32px 0 14px;color:#1c150f;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:500;font-size:32px;line-height:1.1;letter-spacing:-0.02em;">${safeTitle}</h1>

          <div class="sp-body" style="margin:0 0 28px;color:#4a3f33;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;">${bodyHtml}</div>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td class="sp-btn" bgcolor="#1c150f" style="background:#1c150f;border-radius:999px;mso-padding-alt:0;">
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeHref}" style="height:46px;v-text-anchor:middle;width:260px;" arcsize="50%" strokecolor="#1c150f" fillcolor="#1c150f">
                  <w:anchorlock/>
                  <center style="color:#fbf5e9;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:500;">${safeLabel}</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-- -->
                <a href="${safeHref}" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:500;color:#fbf5e9;text-decoration:none;letter-spacing:0.02em;border-radius:999px;">${safeLabel}</a>
                <!--<![endif]-->
              </td>
            </tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:36px;">
            <tr>
              <td class="sp-rule" height="1" style="height:1px;line-height:1px;font-size:1px;border-top:1px solid #e8dfd2;">&nbsp;</td>
            </tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
            <tr>
              <td class="sp-muted" style="color:#80715f;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;line-height:1.6;">
                1400 N Sweetzer Ave &nbsp;&middot;&nbsp; West Hollywood, CA
              </td>
            </tr>
          </table>${reasonBlock}

        </td></tr>
      </table>

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
        <tr>
          <td align="center" class="sp-muted" style="padding:22px 20px 0;color:#9d8f79;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:13px;line-height:1;">
            Sunset Penthouse &middot; Est. mid-century
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;

  return { html, text: textBody };
}
```

- [ ] **Step 2: Deno syntax check**

Run: `deno check supabase/functions/_shared/email_layout.ts`
Expected: exit 0, no output. If `deno` is not installed, skip — the function-deploy step below will catch any syntax errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/email_layout.ts
git commit -m "Shared email-layout helper for Sunset Penthouse transactional emails"
```

---

## Task 2: `notify_admin_of_signup` edge function

**Files:**
- Create: `supabase/functions/notify_admin_of_signup/index.ts`

- [ ] **Step 1: Create the function**

Create `supabase/functions/notify_admin_of_signup/index.ts`:

```ts
// supabase/functions/notify_admin_of_signup/index.ts
//
// Triggered by a Supabase Database Webhook on INSERT into `profiles`.
// When the new row has status='pending', emails every approved admin
// plus (if set) ADMIN_NOTIFY_EMAIL with a link to /admin/residents.html.
//
// Auth: the DB webhook sends a custom header `X-Webhook-Secret`
// whose value must match the PROFILES_WEBHOOK_SECRET env var.
//
// Required Supabase secrets:
//   RESEND_API_KEY
//   FROM_EMAIL
//   FROM_NAME                    (defaults to "Sunset Penthouse")
//   SITE_URL                     (defaults to https://1400sweetzer.com)
//   PROFILES_WEBHOOK_SECRET      shared secret with the DB webhook
//   ADMIN_NOTIFY_EMAIL           optional extra recipient (shared inbox)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { renderEmail, escapeHtml } from '../_shared/email_layout.ts';

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL       = Deno.env.get('FROM_EMAIL') || 'onboarding@resend.dev';
const FROM_NAME        = Deno.env.get('FROM_NAME')  || 'Sunset Penthouse';
const SITE_URL         = (Deno.env.get('SITE_URL') || 'https://1400sweetzer.com').replace(/\/$/, '');
const WEBHOOK_SECRET   = Deno.env.get('PROFILES_WEBHOOK_SECRET')!;
const ADMIN_NOTIFY     = (Deno.env.get('ADMIN_NOTIFY_EMAIL') || '').trim();

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
};

interface ProfileRow {
  id: string;
  full_name: string | null;
  unit_number: string | null;
  phone: string | null;
  status: string;
}

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: ProfileRow;
  old_record: ProfileRow | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  // 1. Verify shared secret.
  const given = req.headers.get('x-webhook-secret') || '';
  if (!WEBHOOK_SECRET || given !== WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  // 2. Parse payload.
  let payload: WebhookPayload;
  try { payload = await req.json(); }
  catch { return new Response('Bad JSON', { status: 400, headers: cors }); }

  if (payload.type !== 'INSERT' || payload.table !== 'profiles') {
    return new Response(JSON.stringify({ skipped: 'wrong event' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  const row = payload.record;
  if (!row || row.status !== 'pending') {
    return new Response(JSON.stringify({ skipped: 'not pending' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 3. Look up applicant's email.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: applicantUser } = await admin.auth.admin.getUserById(row.id);
  const applicantEmail = applicantUser?.user?.email || '';

  // 4. Build recipient list: approved admins + optional shared inbox.
  const { data: adminProfiles } = await admin
    .from('profiles')
    .select('id')
    .eq('role', 'admin')
    .eq('status', 'approved');
  const adminIds = new Set((adminProfiles || []).map((p) => p.id));

  const { data: usersPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const adminEmails = (usersPage?.users || [])
    .filter((u) => adminIds.has(u.id) && !!u.email)
    .map((u) => u.email!.toLowerCase());

  const recipients = Array.from(new Set(
    [...adminEmails, ADMIN_NOTIFY.toLowerCase()].filter(Boolean)
  ));

  if (recipients.length === 0) {
    return new Response(JSON.stringify({ sent: 0, message: 'No admin recipients' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 5. Build and send.
  const fullName = (row.full_name || 'Unnamed').trim();
  const unit     = (row.unit_number || '').trim();
  const phone    = (row.phone || '').trim();
  const when     = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const reviewUrl = `${SITE_URL}/admin/residents.html`;
  const subject = `New resident request — ${fullName}${unit ? `, Unit ${unit}` : ''}`;

  const bodyHtml = `
    <p style="margin:0 0 18px;">A new resident just requested access.</p>
    <p style="margin:0 0 6px;"><strong>${escapeHtml(fullName)}</strong>${unit ? ` — Unit ${escapeHtml(unit)}` : ''}</p>
    <p style="margin:0 0 6px;">${escapeHtml(applicantEmail)}${phone ? ` &middot; ${escapeHtml(phone)}` : ''}</p>
    <p style="margin:0 0 0;color:#80715f;font-size:13px;">Requested ${escapeHtml(when)}</p>
  `;

  const reasonHtml = `You're receiving this because you're a board member at 1400 N Sweetzer Ave.`;

  const textBody = [
    'SUNSET PENTHOUSE  ·  NEW RESIDENT REQUEST',
    '',
    'A new resident just requested access.',
    '',
    `${fullName}${unit ? ` — Unit ${unit}` : ''}`,
    `${applicantEmail}${phone ? ` · ${phone}` : ''}`,
    `Requested ${when}`,
    '',
    `Review in admin: ${reviewUrl}`,
    '',
    '—',
    '1400 N Sweetzer Ave · West Hollywood, CA',
  ].join('\n');

  const { html, text } = renderEmail({
    kicker: 'New resident request',
    title: 'A new resident just requested access.',
    bodyHtml,
    cta: { href: reviewUrl, label: 'Review in admin →' },
    reasonHtml,
    previewText: `${fullName}${unit ? `, Unit ${unit}` : ''}`,
    textBody,
  });

  const fromHeader = `${FROM_NAME} <${FROM_EMAIL}>`;
  const batch = recipients.map((to) => ({
    from: fromHeader, to, subject, html, text,
  }));

  const resendRes = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(batch),
  });

  const resendBody = await resendRes.text();
  let parsed: unknown;
  try { parsed = JSON.parse(resendBody); } catch { parsed = resendBody; }

  return new Response(JSON.stringify({
    ok: resendRes.ok,
    sent: recipients.length,
    resend: parsed,
  }), {
    status: resendRes.ok ? 200 : 502,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/notify_admin_of_signup/index.ts
git commit -m "Edge function: notify_admin_of_signup (DB webhook → admins)"
```

---

## Task 3: Deploy `notify_admin_of_signup` + set secrets

**Files:** (no code changes)

- [ ] **Step 1: Set new secrets**

Run (replace `<generated-random-string>` with a long random value, e.g. `openssl rand -hex 32`):

```bash
supabase secrets set \
  PROFILES_WEBHOOK_SECRET=<generated-random-string> \
  ADMIN_NOTIFY_EMAIL=board@1400sweetzer.com
```

Expected: `Finished supabase secrets set`.

(If the shared board inbox doesn't exist yet, omit `ADMIN_NOTIFY_EMAIL` from this command — the function treats it as optional.)

- [ ] **Step 2: Deploy the function**

Run: `supabase functions deploy notify_admin_of_signup`
Expected: output ends with `Deployed Function notify_admin_of_signup`.

- [ ] **Step 3: Smoke-test that the function is reachable and secret-gated**

Run:

```bash
curl -i -X POST \
  "$(supabase status -o json | jq -r '.API_URL')/functions/v1/notify_admin_of_signup" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected: `HTTP/2 401` with body `Unauthorized` (because no webhook secret header was sent). If you get a 500 or the function URL isn't reachable, the deploy didn't land — re-run step 2.

---

## Task 4: Create the Supabase Database Webhook

**Files:** (no code changes — Supabase Dashboard config)

- [ ] **Step 1: Create the webhook**

In the Supabase Dashboard → **Database → Webhooks → Create a new hook**, fill in:

- **Name:** `profiles_insert_notify_admin`
- **Table:** `public.profiles`
- **Events:** check **Insert** (uncheck Update and Delete)
- **Type:** **Supabase Edge Functions**
- **Edge Function:** `notify_admin_of_signup`
- **HTTP Method:** `POST`
- **HTTP Headers:**
  - `Content-Type`: `application/json`
  - `X-Webhook-Secret`: (paste the exact value you set for `PROFILES_WEBHOOK_SECRET` in Task 3)
- **HTTP Params:** none

Click **Create webhook**.

- [ ] **Step 2: Confirm it fires by sending a test event**

From the webhook row's menu, click **Send test event** (Supabase provides a synthetic `INSERT` on profiles). Watch the function's logs (Edge Functions → `notify_admin_of_signup` → Logs). Expected: a `200` log line. The synthetic record's `status` may not be `pending`, in which case the function will return `{"skipped":"not pending"}` — that's fine; it proves the webhook can reach the function and the secret validates.

---

## Task 5: Manual E2E test of the admin notification

**Files:** (none)

- [ ] **Step 1: Ensure at least one approved admin exists**

In the Supabase SQL editor:

```sql
select id, full_name, role, status from profiles where role='admin' and status='approved';
```

Expected: at least one row. If none, promote yourself: `update profiles set role='admin', status='approved' where id='<your-uid>';`.

- [ ] **Step 2: Request access as a brand-new email**

Open `/signup.html` in an incognito window. Fill in full name "Test Resident", unit "TEST", a phone number, and an email address you control that is NOT already in the system. Submit.

Expected:
- The signup page shows "Sent. Click the link in the email…"
- The magic-link email arrives at the test address (existing flow).
- Within ~10 seconds, every approved admin + the shared inbox (if configured) receives a "New resident request — Test Resident, Unit TEST" email with the correct chrome and a working "Review in admin →" button that opens `/admin/residents.html`.

- [ ] **Step 3: Verify it didn't fire a second time on other transitions**

In the Supabase SQL editor, flip the test row to `removed` then back to `approved`:

```sql
update profiles set status='removed' where unit_number='TEST';
update profiles set status='approved' where unit_number='TEST';
```

Expected: no additional admin-notification emails (the webhook is INSERT-only).

- [ ] **Step 4: Clean up the test profile**

```sql
delete from auth.users where id = (select id from profiles where unit_number='TEST');
```

(This cascades to `profiles.`)

---

## Task 6: `send_welcome_email` edge function

**Files:**
- Create: `supabase/functions/send_welcome_email/index.ts`

- [ ] **Step 1: Create the function**

Create `supabase/functions/send_welcome_email/index.ts`:

```ts
// supabase/functions/send_welcome_email/index.ts
//
// Called by /admin/residents.html right after the Approve button flips
// a profile from status='pending' to status='approved'. Sends one
// welcome email to the newly-approved resident.
//
// Auth: caller must present a valid JWT and be an approved admin
// (same check as send_news_email).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { renderEmail, escapeHtml } from '../_shared/email_layout.ts';

const RESEND_API_KEY    = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL        = Deno.env.get('FROM_EMAIL') || 'onboarding@resend.dev';
const FROM_NAME         = Deno.env.get('FROM_NAME')  || 'Sunset Penthouse';
const SITE_URL          = (Deno.env.get('SITE_URL') || 'https://1400sweetzer.com').replace(/\/$/, '');

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  // 1. Verify caller is an approved admin.
  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: callerProfile } = await admin
    .from('profiles').select('role, status').eq('id', user.id).single();
  if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
    return new Response('Forbidden', { status: 403, headers: cors });
  }

  // 2. Read payload.
  let body: { profile_id?: string };
  try { body = await req.json(); }
  catch { return new Response('Bad JSON', { status: 400, headers: cors }); }
  const profileId = body.profile_id;
  if (!profileId) {
    return new Response('Missing profile_id', { status: 400, headers: cors });
  }

  // 3. Look up the target profile + email.
  const { data: targetProfile, error: profileErr } = await admin
    .from('profiles')
    .select('id, full_name, unit_number, status')
    .eq('id', profileId).single();
  if (profileErr || !targetProfile) {
    return new Response('Profile not found', { status: 404, headers: cors });
  }
  if (targetProfile.status !== 'approved') {
    return new Response('Profile is not approved', { status: 400, headers: cors });
  }

  const { data: targetUser } = await admin.auth.admin.getUserById(profileId);
  const toEmail = targetUser?.user?.email;
  if (!toEmail) {
    return new Response('No email on user', { status: 400, headers: cors });
  }

  // 4. Build and send.
  const fullName = (targetProfile.full_name || '').trim();
  const signinUrl = `${SITE_URL}/auth/signin.html`;
  const subject = `You're in — welcome to Sunset Penthouse`;

  const greeting = fullName ? `Welcome, ${escapeHtml(fullName)}.` : 'You\u2019re in.';
  const bodyHtml = `
    <p style="margin:0 0 18px;">${greeting}</p>
    <p style="margin:0 0 18px;">Sunset Penthouse is the private resident portal for 1400 N Sweetzer. A board member just approved your account.</p>
    <p style="margin:0 0 0;">Inside you'll find building news, the events calendar, the resident directory, and a list of trusted providers.</p>
  `;

  const textBody = [
    'SUNSET PENTHOUSE  ·  WELCOME',
    '',
    fullName ? `Welcome, ${fullName}.` : "You're in.",
    '',
    'Sunset Penthouse is the private resident portal for 1400 N Sweetzer. A board member just approved your account.',
    '',
    "Inside you'll find building news, the events calendar, the resident directory, and a list of trusted providers.",
    '',
    `Sign in: ${signinUrl}`,
    '',
    '—',
    '1400 N Sweetzer Ave · West Hollywood, CA',
  ].join('\n');

  const { html, text } = renderEmail({
    kicker: 'Welcome',
    title: "You're in.",
    bodyHtml,
    cta: { href: signinUrl, label: 'Sign in →' },
    previewText: 'A board member just approved your account.',
    textBody,
  });

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: toEmail,
      subject,
      html,
      text,
    }),
  });

  const resendBody = await resendRes.text();
  let parsed: unknown;
  try { parsed = JSON.parse(resendBody); } catch { parsed = resendBody; }

  return new Response(JSON.stringify({
    ok: resendRes.ok,
    sent: resendRes.ok ? 1 : 0,
    resend: parsed,
  }), {
    status: resendRes.ok ? 200 : 502,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Deploy**

Run: `supabase functions deploy send_welcome_email`
Expected: output ends with `Deployed Function send_welcome_email`.

- [ ] **Step 3: Smoke-test the auth guard**

Run:

```bash
curl -i -X POST \
  "$(supabase status -o json | jq -r '.API_URL')/functions/v1/send_welcome_email" \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"nope"}'
```

Expected: `HTTP/2 401` with body `Unauthorized` (no JWT presented).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send_welcome_email/index.ts
git commit -m "Edge function: send_welcome_email (admin-triggered welcome)"
```

---

## Task 7: Wire Approve button in `admin/residents.html`

**Files:**
- Modify: `admin/residents.html` around lines 39-111 (the script that loads + manipulates residents).

- [ ] **Step 1: Change `updateStatus` to return success, and add `sendWelcome`**

In `admin/residents.html`, replace the two helper functions near the top of the IIFE (currently at lines 46-55):

```js
const updateStatus = async (id, status) => {
  const { error } = await window.sb
    .from('profiles').update({ status }).eq('id', id);
  if (error) alert('Couldn\u2019t update: ' + error.message);
};
const updateRole = async (id, role) => {
  const { error } = await window.sb
    .from('profiles').update({ role }).eq('id', id);
  if (error) alert('Couldn\u2019t update: ' + error.message);
};
```

with:

```js
const updateStatus = async (id, status) => {
  const { error } = await window.sb
    .from('profiles').update({ status }).eq('id', id);
  if (error) { alert('Couldn\u2019t update: ' + error.message); return false; }
  return true;
};
const updateRole = async (id, role) => {
  const { error } = await window.sb
    .from('profiles').update({ role }).eq('id', id);
  if (error) alert('Couldn\u2019t update: ' + error.message);
};
const sendWelcome = async (profileId) => {
  try {
    const res = await fetch(
      `${window.ENV.SUPABASE_URL}/functions/v1/send_welcome_email`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + session.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profile_id: profileId }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      alert('Approved \u2014 welcome email didn\u2019t send: ' + txt.slice(0, 140));
    }
  } catch (e) {
    alert('Approved \u2014 welcome email didn\u2019t send: ' + (e?.message || e));
  }
};
```

- [ ] **Step 2: Call `sendWelcome` from the Approve button (pending branch only)**

Still in `admin/residents.html`, find the existing Approve-button action (currently at lines 97-103):

```js
actions.push(el('button', {
  class: 'btn-mini', type: 'button', text: 'Approve',
  onclick: async () => {
    await updateStatus(r.id, 'approved');
    load();
  },
}));
```

Replace it with:

```js
actions.push(el('button', {
  class: 'btn-mini', type: 'button', text: 'Approve',
  onclick: async () => {
    const ok = await updateStatus(r.id, 'approved');
    if (ok) sendWelcome(r.id);   // fire-and-forget; only from pending branch
    load();
  },
}));
```

Do NOT add `sendWelcome` to the Restore button in the `removed` branch (lines 145-151) — restoring a previously-removed resident must NOT trigger a welcome email.

- [ ] **Step 3: Bump the cache-busting asset query**

Verify in `admin/residents.html` that scripts load clean (no syntax errors) by opening the file in the browser at `/admin/residents.html` while signed in as an admin. Expected: the list renders as before, no console errors.

- [ ] **Step 4: Commit**

```bash
git add admin/residents.html
git commit -m "Admin: send welcome email when approving a pending signup"
```

---

## Task 8: Manual E2E test of the welcome email

**Files:** (none)

- [ ] **Step 1: Sign up fresh**

Same as Task 5 Step 2 — request access as a brand-new test email ("Test Welcome", unit "WEL"). Confirm the admin-notification email arrives.

- [ ] **Step 2: Approve the test profile**

Open `/admin/residents.html` as an approved admin. Find "Test Welcome · Unit WEL" in the pending section. Click **Approve**.

Expected:
- The row moves to the approved section.
- Within ~10 seconds, the test email address receives a welcome email.
- Subject: "You're in — welcome to Sunset Penthouse".
- Body: "Welcome, Test Welcome." paragraph, explanatory paragraph, feature list paragraph.
- CTA button "Sign in →" links to `/auth/signin.html`.
- Card chrome, SP monogram, dark-mode palette match the magic-link email exactly.

- [ ] **Step 3: Confirm Restore doesn't double-send**

In the admin page, click **Remove** on the test profile, then click **Restore** on the same row (now in the removed section).

Expected: NO welcome email arrives for the restore click. (Only the pending-branch Approve triggers the welcome function.)

- [ ] **Step 4: Confirm rejection is silent**

Sign up another test email ("Test Reject", unit "REJ"). In the admin page, click **Reject**.

Expected: NO welcome email, NO rejection email, just status flip.

- [ ] **Step 5: Clean up test profiles**

```sql
delete from auth.users
where id in (
  select id from profiles where unit_number in ('WEL', 'REJ')
);
```

---

## Task 9: Cross-client render spot-check

**Files:** (none)

- [ ] **Step 1: Open both emails in multiple clients**

Using the test inbox from Task 8, open the admin-notification email and the welcome email in each of:

- Apple Mail macOS, light mode
- Apple Mail macOS, dark mode
- Gmail web, light mode
- Gmail iOS app
- Outlook web (outlook.live.com)

Expected: in each client, the card chrome (cream background, rounded corners, SP monogram, italic Fraunces title, orange kicker, brown pill CTA, dark address strip) renders identically to the existing magic-link sign-in email. No broken layouts, no overlapping text, no raw CSS leaking into the preview line.

- [ ] **Step 2: If anything visually drifts**

The most likely cause is a copy/paste divergence in `supabase/functions/_shared/email_layout.ts`. Diff the chrome in that file against the chrome in `supabase/functions/send_news_email/index.ts` lines 60-209 — they must match byte-for-byte except for the parameterized slots.

---

## Self-review notes

- **Spec coverage:**
  - §"Two new edge functions" — Tasks 2 and 6.
  - §"Shared email chrome" — Task 1.
  - §"Admin residents page change" — Task 7.
  - §"Database webhook configuration" — Task 4.
  - §"Recipient & config details" — Task 3 (secrets) + Task 2 code (dedup, listUsers, profiles filter).
  - §"Error handling" — Task 2 code returns non-2xx cleanly; Task 7 surfaces failures via `alert` without blocking the status update; Task 4 smoke-test proves 401 on missing secret.
  - §"Edge cases" — Task 5 Step 3 verifies INSERT-only firing; Task 8 Step 3 verifies Restore doesn't re-welcome; Task 8 Step 4 verifies reject is silent.
  - §"Testing" — Tasks 5, 8, 9.
- **Placeholders:** none — every step has concrete code, commands, or click-paths.
- **Type consistency:** `profile_id` is the request key for `send_welcome_email` (Task 6 code + Task 7 wiring). `X-Webhook-Secret` header + `PROFILES_WEBHOOK_SECRET` env var (Task 2 code + Tasks 3 & 4 config) — consistent.
- **Out of scope (per spec Follow-ups):** refactoring `send_news_email` onto the shared helper is deferred; the current helper is ready for that follow-up but the existing function is untouched in this plan.
