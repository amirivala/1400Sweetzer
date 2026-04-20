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
const SITE_URL          = (Deno.env.get('SITE_URL') || 'https://1400nsweetzer.com').replace(/\/$/, '');

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
