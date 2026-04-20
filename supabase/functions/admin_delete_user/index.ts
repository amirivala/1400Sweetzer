// supabase/functions/admin_delete_user/index.ts
//
// Called by /admin/residents.html when an admin clicks Reject (on a
// pending signup) or Remove (on an approved resident). Attempts a hard
// delete of the user from auth.users (which cascades to profiles). If
// the resident has authored content (news_posts, events, providers, or
// admin_actions — all ON DELETE RESTRICT), the delete is blocked and
// the function falls back to flipping the profile to status='removed'.
//
// Auth: caller must be an approved admin.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  // 1. Verify caller is an approved admin.
  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: callerProfile } = await admin
    .from('profiles').select('role, status').eq('id', user.id).single();
  if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
    return new Response('Forbidden', { status: 403, headers: cors });
  }

  // 2. Read payload.
  let body: { profile_id?: string };
  try { body = await req.json(); }
  catch { return new Response('Bad JSON', { status: 400, headers: cors }); }
  const profileId = body.profile_id;
  if (!profileId) {
    return new Response('Missing profile_id', { status: 400, headers: cors });
  }

  // 3. Guard: don't let an admin delete themselves.
  if (profileId === user.id) {
    return new Response(JSON.stringify({ ok: false, reason: 'cannot_delete_self' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 4. Attempt hard delete.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(profileId);
  if (!deleteErr) {
    return new Response(JSON.stringify({ ok: true, mode: 'hard_delete' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 5. If FK-restrict blocked the delete (user has content), soft-remove instead.
  const msg = String(deleteErr.message || deleteErr);
  const isFK = /foreign key|violates|restrict/i.test(msg);
  if (isFK) {
    const { error: updErr } = await admin
      .from('profiles').update({ status: 'removed' }).eq('id', profileId);
    if (updErr) {
      return new Response(JSON.stringify({
        ok: false, reason: 'soft_remove_failed', detail: updErr.message,
      }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      ok: true, mode: 'soft_remove', reason: 'has_content',
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    ok: false, reason: 'delete_failed', detail: msg,
  }), {
    status: 500,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
