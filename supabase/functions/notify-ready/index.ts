// About Time — "someone is ready to go" push fan-out.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy new function → name it
// `notify-ready`, paste this file, and turn OFF "Verify JWT" (the function
// verifies the caller itself, and the anon key is already public).
//
// Secrets (Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//
// The client calls this immediately after flipping its own `ready` flag. The
// function re-reads the truth from the database, throttles rapid re-taps, and
// pushes to every other member's registered devices.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

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
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:hello@changelinglabs.com';

  if (!supabaseUrl || !anonKey || !serviceKey || !vapidPublic || !vapidPrivate) {
    return json({ error: 'function is missing environment secrets' }, 500);
  }

  // ── Who is calling? ─────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const asUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: authError } = await asUser.auth.getUser();
  if (authError || !user) return json({ error: 'unauthorized' }, 401);

  let payloadIn: { outing_id?: string };
  try {
    payloadIn = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const outingId = payloadIn.outing_id;
  if (!outingId) return json({ error: 'outing_id is required' }, 400);

  // RLS scopes this read to outings the caller belongs to.
  const { data: me, error: meError } = await asUser
    .from('at_members')
    .select('id, name, ready, last_notified_at')
    .eq('outing_id', outingId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (meError || !me) return json({ error: 'not a member of that outing' }, 403);

  // Re-tapping "ready" must not machine-gun everyone's phone.
  if (me.last_notified_at && Date.now() - new Date(me.last_notified_at).getTime() < 15_000) {
    return json({ skipped: 'throttled' });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [{ data: members }, { data: outing }] = await Promise.all([
    admin.from('at_members').select('id, user_id, name, ready').eq('outing_id', outingId),
    admin.from('at_outings').select('code, title').eq('id', outingId).maybeSingle(),
  ]);

  if (!members || !outing) return json({ error: 'outing not found' }, 404);

  const readyCount = members.filter((m) => m.ready).length;
  const recipientIds = members.filter((m) => m.user_id !== user.id).map((m) => m.user_id);

  await admin
    .from('at_members')
    .update({ last_notified_at: new Date().toISOString() })
    .eq('id', me.id);

  if (recipientIds.length === 0) return json({ sent: 0, reason: 'nobody else has joined yet' });

  const { data: subscriptions } = await admin
    .from('at_push_subscriptions')
    .select('endpoint, p256dh, auth')
    .in('user_id', recipientIds);

  if (!subscriptions || subscriptions.length === 0) {
    return json({ sent: 0, reason: 'no push subscriptions' });
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const body =
    readyCount <= 1
      ? 'Nobody else is ready yet'
      : `${readyCount} of ${members.length} are ready`;

  const message = JSON.stringify({
    title: `${me.name} is ready to go`,
    body: `${body} · ${outing.title}`,
    tag: `at-ready-${outingId}`,
    url: `./?code=${outing.code}`,
    code: outing.code,
  });

  let sent = 0;
  const stale: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message,
          { TTL: 3600, urgency: 'high' },
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 = the browser dropped this subscription; prune it.
        if (status === 404 || status === 410) stale.push(sub.endpoint);
      }
    }),
  );

  if (stale.length > 0) {
    await admin.from('at_push_subscriptions').delete().in('endpoint', stale);
  }

  return json({ sent, ready: readyCount, total: members.length, pruned: stale.length });
});
