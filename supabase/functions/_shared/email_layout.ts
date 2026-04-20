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
