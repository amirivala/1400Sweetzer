// Public Supabase config — safe to commit. The anon key is meant for browser use;
// row-level security in the database controls what callers can actually access.
window.ENV = {
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_KEY_HERE',
};
