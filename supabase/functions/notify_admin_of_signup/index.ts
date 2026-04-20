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
//   SITE_URL                     (defaults to https://1400nsweetzer.com)
//   PROFILES_WEBHOOK_SECRET      shared secret with the DB webhook
//   ADMIN_NOTIFY_EMAIL           optional extra recipient (shared inbox)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { renderEmail, escapeHtml } from '../_shared/email_layout.ts';

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL       = Deno.env.get('FROM_EMAIL') || 'onboarding@resend.dev';
const FROM_NAME        = Deno.env.get('FROM_NAME')  || 'Sunset Penthouse';
const SITE_URL         = (Deno.env.get('SITE_URL') || 'https://1400nsweetzer.com').replace(/\/$/, '');
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
