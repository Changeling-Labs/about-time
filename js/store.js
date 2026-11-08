// About Time — data layer.
//
// One interface, two implementations: the Supabase store and an in-memory demo
// store (js/demo.js). The UI never knows which one it is talking to.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, EDGE_FUNCTION } from './config.js';

let client = null;

export function supabaseClient() {
  if (!client) {
    if (!window.supabase?.createClient) {
      throw new Error('Supabase client failed to load');
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

/**
 * Anonymous sign-in. Invisible to the user: no email, no password, no screen.
 * It exists so row-level security can tell devices apart.
 */
export async function ensureSession() {
  const sb = supabaseClient();
  const { data } = await sb.auth.getSession();
  if (data?.session) return data.session;

  const { data: created, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  if (!created?.session) throw new Error('Anonymous sign-in returned no session');
  return created.session;
}

export function createRemoteStore() {
  const sb = supabaseClient();
  let channel = null;

  const row = (data) => (Array.isArray(data) ? data[0] : data);

  return {
    async start({ title, name, emoji }) {
      const { data, error } = await sb.rpc('at_create_outing', {
        p_title: title,
        p_name: name,
        p_emoji: emoji,
      });
      if (error) throw error;
      const r = row(data);
      if (!r) throw new Error('Could not create the outing');
      return {
        outing: { id: r.outing_id, code: r.outing_code, title: r.outing_title },
        memberId: r.member_id,
      };
    },

    async join({ code, name, emoji }) {
      const { data, error } = await sb.rpc('at_join_outing', {
        p_code: code,
        p_name: name,
        p_emoji: emoji,
      });
      if (error) throw error;
      const r = row(data);
      if (!r) throw new Error('Could not join the outing');
      return {
        outing: { id: r.outing_id, code: r.outing_code, title: r.outing_title },
        memberId: r.member_id,
      };
    },

    async fetch(outingId) {
      const [outingRes, membersRes] = await Promise.all([
        sb.from('at_outings').select('id, code, title').eq('id', outingId).maybeSingle(),
        sb.from('at_members').select('*').eq('outing_id', outingId),
      ]);
      if (outingRes.error) throw outingRes.error;
      if (membersRes.error) throw membersRes.error;
      return { outing: outingRes.data, members: membersRes.data ?? [] };
    },

    async patchMe(memberId, patch) {
      const { data, error } = await sb
        .from('at_members')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', memberId)
        .select()
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    watch(outingId, onChange) {
      this.unwatch();
      channel = sb
        .channel(`at-${outingId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'at_members',
            filter: `outing_id=eq.${outingId}`,
          },
          onChange,
        )
        .subscribe();
      return channel;
    },

    unwatch() {
      if (channel) {
        sb.removeChannel(channel);
        channel = null;
      }
    },

    async leave(outingId) {
      const { error } = await sb.rpc('at_leave_outing', { p_outing_id: outingId });
      if (error) throw error;
    },

    async saveSubscription({ outingId, endpoint, p256dh, auth }) {
      const { data } = await sb.auth.getUser();
      const userId = data?.user?.id;
      if (!userId) throw new Error('Not signed in');

      const { error } = await sb.from('at_push_subscriptions').upsert(
        { user_id: userId, outing_id: outingId, endpoint, p256dh, auth },
        { onConflict: 'endpoint' },
      );
      if (error) throw error;
    },

    async notifyReady(outingId) {
      const { error } = await sb.functions.invoke(EDGE_FUNCTION, {
        body: { outing_id: outingId },
      });
      if (error) throw error;
    },
  };
}
