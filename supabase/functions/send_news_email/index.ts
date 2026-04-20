// supabase/functions/send_news_email/index.ts
//
// Called by /admin/news-edit.html after an admin publishes a news post
// (when the "Email residents" toggle is on). Verifies the caller is an
// approved admin, then sends a notification email via Resend to every
// approved resident who hasn't opted out.
//
// Required Supabase secrets (set with `supabase secrets set ...`):
//   RESEND_API_KEY              — your Resend API key
//   FROM_EMAIL                  — e.g. "onboarding@resend.dev" or "notices@1400nsweetzer.com"
//   FROM_NAME                   — sender display name (defaults to "Sunset Penthouse")
//   SITE_URL                    — public origin of the site (e.g. https://1400nsweetzer.com)
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
const SITE_URL           = (Deno.env.get('SITE_URL')   || 'https://1400nsweetzer.com').replace(/\/$/, '');

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
  const excerpt = plain.length > 260 ? plain.slice(0, 260).trimEnd() + '\u2026' : plain;
  const url = `${SITE_URL}/post.html?id=${encodeURIComponent(post.id)}`;
  const prefsUrl = `${SITE_URL}/account.html`;
  const safeTitle = escapeHtml(post.title);
  const safeExcerpt = escapeHtml(excerpt);
  const safeUrl = escapeHtml(url);
  const safePrefs = escapeHtml(prefsUrl);

  // Email-safe cover: fixed inner width (card 600px − 2×44px padding = 512px),
  // display:block kills the phantom baseline, border:0 kills the Outlook border.
  const cover = post.cover_image_url
    ? `
          <tr><td style="padding:28px 0 0;">
            <img src="${escapeHtml(post.cover_image_url)}" alt=""
                 width="512"
                 style="display:block;width:100%;max-width:512px;height:auto;border:0;outline:none;text-decoration:none;border-radius:14px;" />
          </td></tr>`
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
    /* Safe resets */
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
    img  { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    a { text-decoration: none; }

    /* Dark mode — clients that honor prefers-color-scheme (Apple Mail, iOS Mail,
       newer Outlook, HEY) will flip the palette. Gmail ignores this block and
       the light version below is kept deliberately legible. */
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

    /* Phone tweaks */
    @media only screen and (max-width: 620px) {
      .sp-stage-pad { padding: 20px 12px !important; }
      .sp-card-pad  { padding: 30px 26px !important; }
      .sp-title     { font-size: 26px !important; line-height: 1.15 !important; }
      .sp-excerpt   { font-size: 15px !important; }
    }
  </style>
</head>
<body class="sp-stage" style="margin:0;padding:0;background:#f5f0e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <!-- Hidden inbox preview text. Padding characters trail the excerpt so Gmail's
       list view doesn't pull in garbage (e.g. raw CSS) as fallback preview. -->
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
    ${safeExcerpt}
    &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;
    &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;
  </div>

  <table role="presentation" class="sp-stage" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0e6" style="background:#f5f0e6;">
    <tr><td align="center" class="sp-stage-pad" style="padding:40px 20px;">

      <!-- Card -->
      <table role="presentation" class="sp-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fffaf0;border-radius:22px;box-shadow:0 24px 60px rgba(28,21,15,0.10);">
        <tr><td class="sp-card-pad" style="padding:44px 44px 40px;">

          <!-- Masthead: SP monogram + brand -->
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
                <div class="sp-kicker" style="margin-top:3px;color:#b94a2c;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.24em;text-transform:uppercase;line-height:1;">Resident Notice</div>
              </td>
            </tr>
          </table>

          <!-- Optional cover image -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cover}
          </table>

          <!-- Title -->
          <h1 class="sp-ink sp-title" style="margin:28px 0 14px;color:#1c150f;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:500;font-size:32px;line-height:1.1;letter-spacing:-0.02em;">${safeTitle}</h1>

          <!-- Excerpt -->
          <p class="sp-body sp-excerpt" style="margin:0 0 30px;color:#4a3f33;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;">${safeExcerpt}</p>

          <!-- Bulletproof CTA -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td class="sp-btn" bgcolor="#1c150f" style="background:#1c150f;border-radius:999px;mso-padding-alt:0;">
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeUrl}" style="height:46px;v-text-anchor:middle;width:260px;" arcsize="50%" strokecolor="#1c150f" fillcolor="#1c150f">
                  <w:anchorlock/>
                  <center style="color:#fbf5e9;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:500;">Read on Sunset Penthouse &rarr;</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-- -->
                <a href="${safeUrl}" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:500;color:#fbf5e9;text-decoration:none;letter-spacing:0.02em;border-radius:999px;">Read on Sunset Penthouse &rarr;</a>
                <!--<![endif]-->
              </td>
            </tr>
          </table>

          <!-- Hairline -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:38px;">
            <tr>
              <td class="sp-rule" height="1" style="height:1px;line-height:1px;font-size:1px;border-top:1px solid #e8dfd2;">&nbsp;</td>
            </tr>
          </table>

          <!-- Address strip, mirrors the site footer -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
            <tr>
              <td class="sp-muted" style="color:#80715f;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;line-height:1.6;">
                1400 N Sweetzer Ave &nbsp;&middot;&nbsp; West Hollywood, CA
              </td>
            </tr>
          </table>

          <!-- Reason + preferences -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
            <tr>
              <td class="sp-muted" style="color:#80715f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.65;">
                You're receiving this because you live at 1400 N Sweetzer Ave and have resident-news emails turned on.
                <a href="${safePrefs}" style="color:#b94a2c;text-decoration:underline;">Manage email preferences</a>.
              </td>
            </tr>
          </table>

        </td></tr>
      </table>

      <!-- Wordmark under the card -->
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

  const text = [
    `SUNSET PENTHOUSE  ·  RESIDENT NOTICE`,
    ``,
    post.title,
    ``,
    excerpt,
    ``,
    `Read on Sunset Penthouse: ${url}`,
    ``,
    `—`,
    `1400 N Sweetzer Ave · West Hollywood, CA`,
    `Manage email preferences: ${prefsUrl}`,
  ].join('\n');

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
