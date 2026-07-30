// GDPR Article 17 — account erasure.
//
// This exists as an Edge Function for one reason: deleting an auth user needs
// the service-role key, and that key must never reach a client bundle. The
// function is the only thing that holds it.
//
// Safety properties, in order of how badly they would go wrong if missing:
//
//   1. The user to delete is taken from the caller's own JWT, never from the
//      request body. There is no parameter that names a user, so this endpoint
//      cannot be aimed at somebody else's account no matter what is posted.
//   2. The JWT is verified by asking Auth to resolve it, not by decoding it
//      client-side — a forged or expired token resolves to no user and is
//      rejected.
//   3. Everything downstream goes by `ON DELETE CASCADE` from auth.users, which
//      is enforced by the database rather than by a list of tables maintained
//      here. A table added later is covered automatically, as long as it
//      declares the same foreign key. That is deliberate: an explicit delete
//      list is a thing you forget to update, and the failure is silent.
//
// Deploy:  supabase functions deploy delete-account
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the
//          platform; nothing needs to be set by hand.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing authorization' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'Server misconfigured' }, 500);

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve the caller from their token. This is the only source of the user id.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'Invalid or expired session' }, 401);

  // Require an explicit confirmation flag so a stray POST cannot erase an
  // account. The UI already double-confirms; this is the backstop.
  let confirmed = false;
  try {
    const body = await req.json();
    confirmed = body?.confirm === true;
  } catch {
    confirmed = false;
  }
  if (!confirmed) return json({ error: 'Missing confirmation' }, 400);

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error('delete-account failed', { userId: user.id, message: delErr.message });
    return json({ error: 'Deletion failed' }, 500);
  }

  // Deliberately logged without the email address: this line exists to prove a
  // deletion happened if anyone ever asks, and writing the identifier of a user
  // who just exercised their right to erasure into a log would rather defeat
  // the point.
  console.log('account deleted', { userId: user.id, at: new Date().toISOString() });

  return json({ deleted: true });
});
