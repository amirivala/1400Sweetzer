# Sunset Penthouse · Resident Portal

Private web portal for the residents of Sunset Penthouse — 1400 N Sweetzer Ave, West Hollywood. (The repo is named `1400Sweetzer` after the address; the building's name is "Sunset Penthouse".)

See `docs/superpowers/specs/2026-04-17-1400sweetzer-resident-portal-design.md` for the full design.

## Local development

This is a static site — no build step. Open `index.html` in a browser, or serve locally with:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deployment

Hosted on Vercel at [1400nsweetzer.com](https://1400nsweetzer.com). Pushes to
`main` auto-deploy. The project is a pure static site — no build step. Security
headers and asset cache policy live in `vercel.json`.

Environment-specific configuration (Supabase URL + publishable key) is in
`/assets/env.js` and is **safe to commit** (RLS enforces access).

## Email

Outbound mail (news posts, welcome emails, admin signup notifications) is
sent via [Resend](https://resend.com). The three Supabase Edge Functions
(`send_news_email`, `send_welcome_email`, `notify_admin_of_signup`) all
read these env vars (set in **Supabase → Project Settings → Edge Function
Secrets**):

- `RESEND_API_KEY` — Resend API key
- `FROM_EMAIL` — From address (e.g. `notices@1400nsweetzer.com`)
- `FROM_NAME` — From display name (defaults to `Sunset Penthouse`)
- `BOARD_REPLY_TO` — Reply-To address (`board@1400nsweetzer.com`)

Inbound mail to `board@1400nsweetzer.com` is forwarded by
[ImprovMX](https://improvmx.com) (free plan) to all current admins'
personal inboxes. To add or remove an admin:

1. Sign in to ImprovMX → `1400nsweetzer.com` domain
2. Edit the `board` alias's "Forwards to" list (comma-separated)
3. Save — takes effect immediately, no code change

DNS records for email live on Vercel DNS for `1400nsweetzer.com`:

| Type | Name | Value |
|---|---|---|
| MX  | @ | `mx1.improvmx.com` (priority 10) |
| MX  | @ | `mx2.improvmx.com` (priority 20) |
| TXT | @ | `v=spf1 include:spf.improvmx.com include:_spf.resend.com ~all` |

The SPF record authorizes both ImprovMX (inbound forwarding) and Resend
(outbound site emails) to handle mail for the domain. Keep them on a
single TXT record — multiple SPF TXT records break authentication.

## Keeping Supabase awake

Supabase pauses free-plan projects after ~7 days of low API activity. A paused
project takes the whole portal down (sign-in, directory, news, calendar) until
someone manually restores it from the Supabase dashboard.

`.github/workflows/supabase-keepalive.yml` prevents that: a scheduled GitHub
Action runs a one-row REST query against `news_posts` every day at 07:23 UTC,
which counts as activity. It uses the publishable (anon) key, which is public
anyway — it ships in `assets/env.js`.

**Caveat — the 60-day rule.** GitHub automatically disables scheduled workflows
in public repos after 60 days with no repository activity, and emails the owner
a few days beforehand. If the keep-alive is disabled, Supabase will pause
roughly a week later. Two ways to keep it alive:

- Push any commit to `main` — that resets the 60-day clock.
- Or re-enable it from the repo's **Actions → Supabase keep-alive** page, or
  with `gh workflow enable supabase-keepalive.yml`.

To verify it is still running: `gh run list --workflow=supabase-keepalive.yml`.

## Bootstrap (one-time)

After running migrations, manually promote the first admin in Supabase SQL Editor:

```sql
update profiles
set role = 'admin', status = 'approved'
where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
```
