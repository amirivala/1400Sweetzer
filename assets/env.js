// Public Supabase config — safe to commit. Both the legacy `anon` JWT key
// and the newer `sb_publishable_*` key are designed for browser use; row-level
// security in the database controls what callers can actually access.
window.ENV = {
  SUPABASE_URL: 'https://nvazngprbjccclzmgphg.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Dm9QjMYym_e0kwzMo4v3fA_WPangWJB',
};
