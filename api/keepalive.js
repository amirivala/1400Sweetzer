// Keeps the Supabase free-plan project from being paused for inactivity.
//
// Supabase pauses free projects after ~7 days of low API activity, which takes
// the whole portal down until someone restores it by hand. This endpoint runs a
// trivial read against the REST API, which counts as activity. It is invoked
// once a day by the cron entry in vercel.json.
//
// The URL and key below mirror assets/env.js. The publishable (anon) key is
// public by design — it ships to every browser, and RLS controls access.

const SUPABASE_URL = 'https://nvazngprbjccclzmgphg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Dm9QjMYym_e0kwzMo4v3fA_WPangWJB';

module.exports = async (req, res) => {
  // Vercel sends `Authorization: Bearer $CRON_SECRET` when that env var is set
  // on the project. If it is not set, the endpoint stays open — it only does a
  // public read, so the worst an outside caller can do is waste an invocation.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/news_posts?select=id&limit=1`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, supabase: r.status });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err) });
  }
};
