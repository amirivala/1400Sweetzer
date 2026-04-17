// Redirects un-signed-in or non-approved users away from this page.
// Include AFTER supabase-client.js on any page that requires an approved session.
(async () => {
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) {
    location.href = '/';
    return;
  }

  const { data: profile, error } = await window.sb
    .from('profiles')
    .select('status')
    .eq('id', session.user.id)
    .single();

  if (error || !profile || profile.status !== 'approved') {
    await window.sb.auth.signOut();
    location.href = '/';
  }
})();
