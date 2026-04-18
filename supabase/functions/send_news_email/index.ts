// supabase/functions/send_news_email/index.ts
//
// Called by /admin/news-edit.html after an admin publishes a news post
// (when the "Email residents" toggle is on). Verifies the caller is an
// approved admin, then sends a notification email via Resend to every
// approved resident who hasn't opted out.
//
// Required Supabase secrets (set with `supabase secrets set ...`):
//   RESEND_API_KEY              — your Resend API key
//   FROM_EMAIL                  — e.g. "onboarding@resend.dev" or "notices@1400sweetzer.com"
//   FROM_NAME                   — sender display name (defaults to "Sunset Penthouse")
//   SITE_URL                    — public origin of the site (e.g. https://1400sweetzer.com)
//
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// auto-injected by the Supabase Functions runtime.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const RESEND_API_KEY     = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY  = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL         = Deno.env.get('FROM_EMAIL')  || 'onboarding@resend.dev';
const FROM_NAME          = Deno.env.get('FROM_NAME')   || 'Sunset Penthouse';
const SITE_URL           = (Deno.env.get('SITE_URL')   || 'https://1400sweetzer.com').replace(/\/$/, '');

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildEmail(post: { id: string; title: string; body: string; cover_image_url: string | null }) {
  const plain = String(post.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const excerpt = plain.length > 240 ? plain.slice(0, 240).trimEnd() + '\u2026' : plain;
  const url = `${SITE_URL}/post.html?id=${encodeURIComponent(post.id)}`;
  const safeTitle = escapeHtml(post.title);
  const safeExcerpt = escapeHtml(excerpt);
  const cover = post.cover_image_url
    ? `<img src="${escapeHtml(post.cover_image_url)}" alt="" style="width:100%;border-radius:12px;margin:0 0 18px;" />`
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f0e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;margin:0 auto;background:#fffaf0;border-radius:18px;padding:32px;color:#1c150f;">
    <tr><td>
      <p style="font-family:ui-monospace,SF Mono,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#b94a2c;margin:0 0 14px;">Sunset Penthouse</p>
      ${cover}
      <h1 style="font-family:Georgia,serif;font-style:italic;font-weight:500;font-size:28px;line-height:1.1;letter-spacing:-0.02em;margin:0 0 14px;">${safeTitle}</h1>
      <p style="color:#4a3f33;font-size:15px;line-height:1.55;margin:0 0 26px;">${safeExcerpt}</p>
      <a href="${url}" style="display:inline-block;background:#1c150f;color:#fffaf0;padding:13px 22px;border-radius:999px;text-decoration:none;font-size:14px;font-weight:500;">Read on Sunset Penthouse \u2192</a>
      <p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e8dfd2;color:#80715f;font-size:12px;line-height:1.55;">
        You're getting this because you live at 1400 N Sweetzer Ave.
        <a href="${SITE_URL}/account.html" style="color:#b94a2c;">Manage email preferences</a>.
      </p>
    </td></tr>
  </table>
</body></html>`;

  const text = `${post.title}\n\n${excerpt}\n\nRead: ${url}\n\nManage email preferences: ${SITE_URL}/account.html`;
  return { html, text };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // 1. Verify caller is an approved admin.
  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: callerProfile } = await admin
    .from('profiles').select('role, status').eq('id', user.id).single();
  if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }

  // 2. Read payload.
  let body: { post_id?: string };
  try { body = await req.json(); }
  catch { return new Response('Bad JSON', { status: 400, headers: corsHeaders }); }
  const postId = body.post_id;
  if (!postId) {
    return new Response('Missing post_id', { status: 400, headers: corsHeaders });
  }

  // 3. Fetch the post.
  const { data: post, error: postErr } = await admin
    .from('news_posts')
    .select('id, title, body, cover_image_url, published')
    .eq('id', postId).single();
  if (postErr || !post) {
    return new Response('Post not found', { status: 404, headers: corsHeaders });
  }
  if (!post.published) {
    return new Response('Post is not published', { status: 400, headers: corsHeaders });
  }

  // 4. Find opted-in approved residents and look up their emails.
  const { data: profiles } = await admin
    .from('profiles')
    .select('id')
    .eq('status', 'approved')
    .eq('email_news_optin', true);
  const optInIds = new Set((profiles || []).map((p) => p.id));

  // listUsers gives us emails. 1000 per page is plenty for one building.
  const { data: usersPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const recipients = (usersPage?.users || [])
    .filter((u) => optInIds.has(u.id) && !!u.email)
    .map((u) => u.email!);

  if (recipients.length === 0) {
    return new Response(JSON.stringify({ sent: 0, message: 'No opted-in recipients' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 5. Build the email and send via Resend's batch endpoint.
  const { html, text } = buildEmail(post);
  const fromHeader = `${FROM_NAME} <${FROM_EMAIL}>`;
  const batch = recipients.map((to) => ({
    from: fromHeader,
    to,
    subject: post.title,
    html,
    text,
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
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
