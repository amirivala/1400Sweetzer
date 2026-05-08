// Initializes a single Supabase client and exposes it as window.sb.
// All pages that need DB / auth access load this script.
(() => {
  const { createClient } = window.supabase;
  window.sb = createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);

  // Wipe the nav cache on sign-out so the next visitor on this device
  // — possibly a different account — doesn't see a flash of the
  // previous user's name or admin link before the pill rehydrates.
  window.sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      try { localStorage.removeItem('sp_nav_cache_v1'); } catch {}
    }
  });
})();
