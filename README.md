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

Pushes to `main` auto-deploy to Cloudflare Pages.

## Bootstrap (one-time)

After running migrations, manually promote the first admin in Supabase SQL Editor:

```sql
update profiles
set role = 'admin', status = 'approved'
where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
```
