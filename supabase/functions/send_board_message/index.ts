// supabase/functions/send_board_message/index.ts
//
// Called by /contact.html. Verifies the caller is an approved resident,
// then relays their message to the board alias via Resend with Reply-To
// set to the resident's email — board members answer from their own
// inboxes and the conversation continues over plain email. The resident
// gets a copy so the thread starts in their inbox too.
//
// Required Supabase secrets (set with `supabase secrets set ...`):
//   RESEND_API_KEY              — your Resend API key
//   FROM_EMAIL                  — e.g. "notices@1400nsweetzer.com"
//   FROM_NAME                   — sender display name (defaults to "Sunset Penthouse")
//   SITE_URL                    — public origin of the site
//
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// auto-injected by the Supabase Functions runtime.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { renderEmail, escapeHtml } from '../_shared/email_layout.ts';

const RESEND_API_KEY    = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL        = Deno.env.get('FROM_EMAIL') || 'onboarding@resend.dev';
const FROM_NAME         = Deno.env.get('FROM_NAME')  || 'Sunset Penthouse';
const SITE_URL          = (Deno.env.get('SITE_URL')  || 'https://1400nsweetzer.com').replace(/\/$/, '');
// ImprovMX forwards this alias to all current board members' inboxes.
const BOARD_EMAIL       = Deno.env.get('BOARD_EMAIL') || 'board@1400nsweetzer.com';

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Escaped paragraphs with single newlines kept as <br />.
function messageHtml(message: string): string {
  return message
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em;">${escapeHtml(p.trim()).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // 1. Verify the caller is a signed-in, approved resident.
  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user || !user.email) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await admin
    .from('profiles')
    .select('full_name, unit_number, status')
    .eq('id', user.id)
    .single();
  if (!profile || profile.status !== 'approved') {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }

  // The claimed roster row is the authoritative name/unit when it exists.
  const { data: resident } = await admin
    .from('residents')
    .select('display_name, unit_number')
    .eq('profile_id', user.id)
    .maybeSingle();

  const senderName  = resident?.display_name || profile.full_name || user.email;
  const senderUnit  = resident?.unit_number || profile.unit_number || '—';
  const senderEmail = user.email;
  const firstName   = String(senderName).trim().split(/\s+/)[0];

  // 2. Read and validate the payload.
  let body: { subject?: string; message?: string };
  try { body = await req.json(); }
  catch { return new Response('Bad JSON', { status: 400, headers: corsHeaders }); }

  const subject = String(body.subject || '').trim();
  const message = String(body.message || '').trim();
  if (!subject || !message) {
    return jsonResponse(400, { error: 'Subject and message are both required.' });
  }
  if (subject.length > SUBJECT_MAX || message.length > MESSAGE_MAX) {
    return jsonResponse(400, { error: 'Message is too long.' });
  }

  // 3. Board email: Reply-To goes straight back to the resident.
  const senderLine =
    `<p style="margin:0 0 1.4em;color:#80715f;font-size:13px;">` +
    `From <strong style="color:#4a3f33;">${escapeHtml(senderName)}</strong>` +
    ` &middot; Unit ${escapeHtml(senderUnit)}` +
    ` &middot; <a href="mailto:${escapeHtml(senderEmail)}" style="color:#b94a2c;">${escapeHtml(senderEmail)}</a></p>`;

  const boardEmail = renderEmail({
    kicker: 'Resident message',
    title: subject,
    bodyHtml: senderLine + messageHtml(message),
    cta: {
      href: `mailto:${senderEmail}?subject=${encodeURIComponent('Re: ' + subject)}`,
      label: `Reply to ${firstName} →`,
    },
    reasonHtml:
      `Sent from the Contact the Board page by an approved resident. ` +
      `Replying to this email goes directly to ${escapeHtml(senderName)}.`,
    previewText: `Unit ${senderUnit} · ${senderName}: ${message.slice(0, 140)}`,
    textBody: [
      `RESIDENT MESSAGE · Unit ${senderUnit} · ${senderName} <${senderEmail}>`,
      ``,
      subject,
      ``,
      message,
      ``,
      `—`,
      `Reply to this email to answer ${firstName} directly.`,
    ].join('\n'),
  });

  // 4. Resident copy: replying to it reaches the board.
  const copyEmail = renderEmail({
    kicker: 'Message sent',
    title: subject,
    bodyHtml:
      `<p style="margin:0 0 1.4em;">Here’s a copy of your message to the board. ` +
      `They’ll reply directly to this address.</p>` +
      messageHtml(message),
    cta: { href: `${SITE_URL}/home.html`, label: 'Open Sunset Penthouse →' },
    reasonHtml:
      `You’re receiving this because you sent the board a message from the ` +
      `Contact page. Replying to this email reaches the board too.`,
    previewText: `Your message to the board: ${message.slice(0, 140)}`,
    textBody: [
      `YOUR MESSAGE TO THE BOARD`,
      ``,
      subject,
      ``,
      message,
      ``,
      `—`,
      `The board will reply to this address. Replying to this email reaches the board too.`,
    ].join('\n'),
  });

  const fromHeader = `${FROM_NAME} <${FROM_EMAIL}>`;
  const batch = [
    {
      from: fromHeader,
      to: BOARD_EMAIL,
      reply_to: senderEmail,
      subject: `[Unit ${senderUnit}] ${subject}`,
      html: boardEmail.html,
      text: boardEmail.text,
    },
    {
      from: fromHeader,
      to: senderEmail,
      reply_to: BOARD_EMAIL,
      subject: `Your message to the board: ${subject}`,
      html: copyEmail.html,
      text: copyEmail.text,
    },
  ];

  const resendRes = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(batch),
  });

  if (!resendRes.ok) {
    const detail = await resendRes.text();
    console.error('Resend batch failed', resendRes.status, detail);
    return jsonResponse(502, { error: 'Email delivery failed. Please try again.' });
  }

  return jsonResponse(200, { ok: true });
});
