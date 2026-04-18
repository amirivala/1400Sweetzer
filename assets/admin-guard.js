// Like auth-guard, but also requires the user to be an approved admin.
// Use INSTEAD of auth-guard.js on /admin/* pages.

(async () => {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) { location.href = '/'; return; }

  const { data: profile, error } = await window.sb
    .from('profiles')
    .select('status, role')
    .eq('id', session.user.id)
    .single();

  if (error || !profile || profile.status !== 'approved' || profile.role !== 'admin') {
    location.href = '/home.html';
  }
})();
