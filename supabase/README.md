# About Time — backend setup

About Time lives inside the **Pulse** Supabase project (`kjlmkjkzbbnzdpvjhkxz`) because the free tier allows two active projects. Everything it creates is prefixed `at_`, so it can never collide with Pulse's `sync_rows`.

Three one-time steps. None of them touch existing Pulse data.

---

## 1. Allow anonymous sign-ins

Dashboard → **Authentication → Sign In / Providers** → **Allow anonymous sign-ins = ON**.

Why: a family joins with a six-character code, not an email. Anonymous sign-in gives each device a real `auth.uid()` behind the scenes, which is what makes row-level security and Realtime work. The user never sees a sign-up screen.

This does **not** weaken Pulse. Its `sync_rows` policy is still `auth.uid() = user_id`, so an anonymous account can only ever write its own rows — exactly like a magic-link account.

If this toggle is off, the app shows: *"Anonymous sign-in is switched off in Supabase."*

## 2. Run the schema

Dashboard → **SQL Editor** → paste all of `schema.sql` → **Run**.

It is idempotent, so re-running is safe. It creates:

- `at_outings`, `at_members`, `at_push_subscriptions`
- `at_is_member()` — a `security definer` helper so the members policy can check membership without recursing
- `at_create_outing()`, `at_join_outing()`, `at_leave_outing()` — the only way rows are inserted
- RLS policies and grants
- The `at_members` Realtime publication entry

Sanity check afterwards:

```sql
select relrowsecurity from pg_class where oid = 'public.at_members'::regclass;  -- true
select tablename from pg_publication_tables where pubname = 'supabase_realtime'; -- includes at_members
```

## 3. Deploy the push function

Dashboard → **Edge Functions → Deploy new function**:

- Name: `notify-ready`
- Paste `functions/notify-ready/index.ts`
- **Verify JWT: OFF** — the function calls `auth.getUser()` itself and returns 401 when there is no valid session

Then **Edge Functions → Secrets**:

```
VAPID_PUBLIC_KEY=BGmrJjIFCMzUZc2604j3rePyDCjloomhflTaefCwGH_QmK_3BWTKSChe3luBnXblK-KCHxq1D29HhQs2hlEb2Ng
VAPID_PRIVATE_KEY=<from .secrets/vapid-keys.env>
VAPID_SUBJECT=mailto:hello@changelinglabs.com
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do not add them.

> **Never commit the VAPID private key.** It is generated into `.secrets/vapid-keys.env`, which is gitignored. The public key is deliberately in `js/config.js`; the private key is not.

---

## How the function behaves

- Verifies the caller's JWT, then reads their membership **through RLS** — a non-member gets 403.
- Re-reads the truth from the database rather than trusting the client's count.
- Throttles: 15 seconds between notifications per member, so double-tapping does not machine-gun everyone.
- Sends to every other member's subscriptions with `TTL: 3600` and `urgency: high`.
- Prunes subscriptions that return `404` or `410`.
- Returns `{ sent, ready, total, pruned }`.

Push payload:

```json
{
  "title": "Mum is ready to go",
  "body": "2 of 5 are ready · Ruth & Tom's wedding",
  "tag": "at-ready-<outing id>",
  "code": "K7M2QP"
}
```

`tag` replaces the previous notification instead of stacking them. The service worker turns `code` into a deep link.

---

## Verifying end to end

1. Enable anonymous sign-in, run the schema, deploy the function.
2. Open the app in two browsers (or one normal + one private window) on **different ports or profiles** — the session is per-device.
3. Start an outing in window A, join with the code in window B.
4. Change a battery in B; A should update without a reload (Realtime).
5. Tap **I'm ready to go** in B; A should get a push within a couple of seconds.

If Realtime updates but push does not, the function is the problem — check **Edge Functions → Logs**. The most common cause is a missing or mismatched VAPID private key.

---

## Known limits

- **iOS:** Web Push requires the PWA to be added to the Home Screen (16.4+). The UI explains this.
- **Notifications are per device.** Clearing site data loses the subscription; the app re-subscribes when alerts are next enabled.
- **Leaving an outing deletes your member row.** The outing is deleted when the last person leaves.
- **No server-side cleanup of old outings.** Each outing is a handful of tiny rows, so this is fine at family scale.
