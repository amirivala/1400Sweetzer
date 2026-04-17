// Initializes a single Supabase client and exposes it as window.sb.
// All pages that need DB / auth access load this script.
(() => {
  const { createClient } = window.supabase;
  window.sb = createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);
})();
