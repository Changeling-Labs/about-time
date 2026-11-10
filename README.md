# ⏳ About Time

**A quiet way for a family to say how much social battery is left — and when they're ready to go.**

Open it at church, at a wedding reception, at a long lunch. Everyone taps their battery, and when someone has had enough they tap one button. Everyone else's phone gets a nudge. No debate, no group chat, no *"are we leaving soon?"* dance.

- **No accounts, no passwords.** One person starts an outing and shares a six-character code.
- **Five-tap social battery.** Empty, Low, Half, Good, Full — faster than a slider and impossible to fumble in a loud room.
- **One big "I'm ready to go" button.** Tap again to take it back.
- **Live updates** over Supabase Realtime, with a slow poll as insurance for bad venue wifi.
- **Real Web Push**, so it reaches a phone in a pocket with the app closed.
- **Installable PWA.** Cache-first shell, light and dark, WCAG AA, Lighthouse 100/100/100.

Status: **v0.2.0** — built, unit-tested, browser-verified and live.
**Live:** https://changelinglabs.com/about-time/
The Supabase backend is on (anonymous auth, schema, `notify-ready`) and the two-device test passed: live status sync plus Web Push on macOS and on the iPhone Home Screen app.

**v0.2.0 adds:** an invite link opened while already in an outing now asks before switching; invite links put the join card at the top of the landing screen; a full **Alerts & install** help sheet with browser-specific notification and install steps (plus a real Chrome install button); and a quiet version number in the footer and help sheet.

---

## Try it without a backend

```bash
npm run serve
# open http://localhost:8940/?demo=1
```

`?demo=1` runs the whole interface against an in-memory store with five people and a scripted *"Grace is ready"* moment. `?demo=1&view=landing` shows the start/join screen.

---

## How it works

```
 Phone A                Supabase                         Phone B
 ───────                ────────                         ───────
 tap "ready"  ───────▶  at_members.ready = true
                        │
                        ├── Realtime ───────────────────▶ screen updates instantly
                        │
                        └── Edge Function ── Web Push ──▶ notification
```

1. **Start an outing.** Creates a row in `at_outings` with a random six-character code and adds you to `at_members`.
2. **Everyone joins** with the code (or a shared `?code=XXXXXX` link). Each device gets an invisible Supabase *anonymous* account — no email, no password, no screen. A link opened on a phone that is **already in an outing** asks before switching: leaving the current outing is confirmed, and the new one is joined as the same name and face.
3. **Battery taps** update your own row. Row-level security means you can only ever edit your own row and only see outings you belong to.
4. **"I'm ready"** updates the row (Realtime pushes it to every screen) and calls the `notify-ready` Edge Function, which sends a Web Push to everyone else's registered devices.

The whole app is vanilla ES modules with no build step. State lives in one object in `js/app.js`; every mutation ends in `render()`.

### Files

| Path | What it does |
|---|---|
| `index.html` | Shell, meta tags, boot skeleton |
| `js/app.js` | State, routing, rendering, events |
| `js/lib.js` | Pure helpers — codes, battery levels, sorting, copy. Unit-tested. |
| `js/store.js` | Supabase data layer + anonymous session |
| `js/demo.js` | In-memory store with a scripted demo |
| `js/push.js` | Permission, VAPID subscription |
| `js/config.js` | Public project URL, publishable key, VAPID public key, `APP_VERSION` |
| `sw.js` | Cache-first shell + `push` / `notificationclick` |
| `supabase/schema.sql` | Tables, RLS, RPCs, Realtime publication |
| `supabase/functions/notify-ready/index.ts` | Push fan-out Edge Function |
| `scripts/make-icons.py` | Generates the PNG icons with Pillow |

### Data model

| Table | Purpose |
|---|---|
| `at_outings` | One row per event: `code`, `title`, `created_by` |
| `at_members` | One row per person per outing: `name`, `emoji`, `battery` 0–100, `ready`, `ready_at` |
| `at_push_subscriptions` | One row per device: `endpoint`, `p256dh`, `auth` |

All objects are prefixed `at_` and live in the **Pulse** Supabase project. Nothing touches Pulse's `sync_rows`.

---

## Setup (three one-time dashboard steps)

Already done for the live site on 2026-11-08. Keep this for rebuilding from scratch or moving to another project.

The client config points at the Pulse project.

### 1. Enable anonymous sign-ins

Supabase Dashboard → **Authentication → Sign In / Providers → Allow anonymous sign-ins = ON**.

This is what lets a family join with a code instead of creating accounts. It does not weaken Pulse: every row is still scoped to `auth.uid()`.

### 2. Run the schema

Dashboard → **SQL Editor** → paste all of `supabase/schema.sql` → **Run**. It is idempotent and only creates `at_*` objects.

### 3. Deploy the push function

Dashboard → **Edge Functions → Deploy new function**, name it `notify-ready`, paste `supabase/functions/notify-ready/index.ts`, and **turn off "Verify JWT"** (the function authenticates the caller itself).

Then add three secrets under **Edge Functions → Secrets**:

| Secret | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | see `.secrets/vapid-keys.env` |
| `VAPID_PRIVATE_KEY` | see `.secrets/vapid-keys.env` |
| `VAPID_SUBJECT` | `mailto:hello@changelinglabs.com` |

> The VAPID private key is generated locally into `.secrets/vapid-keys.env`, which is gitignored. Never commit it. The **public** key is already in `js/config.js` and is meant to be public.

Full details and troubleshooting: [`supabase/README.md`](supabase/README.md).

---

## Deploy

Static files only, served by GitHub Pages from `Changeling-Labs/about-time` at `changelinglabs.com/about-time/`. All paths are relative, so the subdirectory works as-is. `.nojekyll` keeps Pages from running Jekyll over the bundle.

**Every release:** bump `APP_VERSION` in `js/config.js` and `version` in `package.json` (they must match — `test/version.test.js` checks), bump `CACHE` in `sw.js`, and add any new module to `ASSETS`. The service worker is cache-first, so a stale client will otherwise keep the old JS. The version is shown in the landing fineprint, the outing footer, and the help sheet, so "which build are you on?" has a real answer.

**iOS push:** Safari only delivers Web Push to a PWA that has been **added to the Home Screen** (iOS 16.4+). The app detects this and explains it instead of showing a dead button.

### Notifications & install

The app never assumes the browser prompt is self-explanatory:

- **Every alerts card states the next action.** "Turn on alerts · your browser will ask · choose Allow", or the exact unblock steps for Chrome / Edge / Safari / Firefox, tailored to the platform.
- **`Alerts & install` help sheet** (landing fineprint, outing footer, and links on the alerts card) explains what alerts do, how to install on iPhone (Home Screen), Safari macOS (Add to Dock), Chrome on Android (⋮ → Add to Home screen) and Chrome/Edge on desktop (install icon or menu → Install page as app), and what to check when nothing arrives.
- **A real install button.** `beforeinstallprompt` is captured, so Chrome gets an "Install app" button that fires the browser's own installation flow instead of instructions for finding a menu.
- **Dismissing the invite doesn't hide the setting.** "Not now" leaves a one-line "Alerts are off — turn them on" control, so the only path to notifications is never closed.
- **iPhone and Safari on macOS are called out separately:** Apple only delivers Web Push to the installed app, never a tab.

---

## Tests

```bash
npm test
```

Node's built-in runner. Covers room-code normalisation, battery snapping, member ordering, summary copy, relative time, notification copy, name cleaning, and the version/cache pairing (`test/version.test.js`).

---

## Design decisions

- **Six-character codes** from an unambiguous alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) — no `I`, `O`, `0` or `1` to mistype at a noisy reception.
- **Five battery steps, not a slider.** One thumb tap, no precision required.
- **Anonymous auth over email links.** Signing five people in with magic links at a wedding is the whole problem this app is trying to avoid.
- **Room codes over invitations.** The code *is* the permission. It is short enough to shout across a table and easy to revoke by leaving.
- **Push on "ready" only.** Battery changes stay silent; the only interruption is the one that matters.
- **A slow poll behind Realtime.** Realtime is the main path, but venue wifi is venue wifi.

## Not built yet

- Thresholds ("2 of 5 ready → we're leaving"). The data supports it; the UI deliberately doesn't.
- Outing history / "remember last time".
- Named devices or per-device push management.
