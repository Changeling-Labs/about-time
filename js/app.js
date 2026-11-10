// About Time — app shell.
//
// Vanilla ES modules, no build step. State lives in one object; every mutation
// ends in render(). Text inputs live on the landing screen and in the
// switch-outing sheet, so a full re-render must not steal focus mid-typing:
// refresh() holds its render while a sheet is open.

import { APP_NAME, APP_TAGLINE, APP_VERSION } from './config.js';
import { createRemoteStore, ensureSession } from './store.js';
import { createDemoStore } from './demo.js';
import {
  batteryLabel,
  batterySegments,
  cleanName,
  codeFromSearch,
  formatCode,
  isValidCode,
  isValidName,
  joinUrl,
  nearestBattery,
  normalizeCode,
  readySummary,
  relativeTime,
  sortMembers,
  summaryText,
  truncate,
} from './lib.js';
import {
  browserName,
  enablePush,
  isAndroid,
  isIOS,
  isSafari,
  isStandalone,
  permission as pushPermission,
  pushSupported,
} from './push.js';

const IDENTITY_KEY = 'about-time.identity.v1';
const PUSH_DISMISSED_KEY = 'about-time.push-dismissed.v2';
const IOS_HINT_KEY = 'about-time.ios-hint-dismissed.v1';
const EMOJIS = ['🦉', '🌷', '🎩', '🐝', '🚀', '🐢', '🍋', '🦊', '🐳', '🌙', '🧢', '☕'];

const state = {
  view: 'boot',
  demo: false,
  store: null,
  outing: null,
  members: [],
  meId: null,
  prefillCode: '',
  busy: false,
  error: '',
  // A sheet is state, not DOM: every render rebuilds the whole view.
  joinSheet: null, // { code, from: 'link' | 'manual' }
  help: false,
  installEvent: null,
  push: { supported: false, permission: 'default', dismissed: false, iosHintDismissed: false },
};

const app = document.getElementById('app');
const toast = document.getElementById('toast');

let refreshTimer = null;
let pollTimer = null;
let lastSheetFocus = '';

// Chrome (Android and desktop) exposes an install prompt. Capture it so the
// app can offer a real Install button instead of describing a menu.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installEvent = event;
  if (state.view !== 'boot' && !state.joinSheet && !state.help) render();
});

window.addEventListener('appinstalled', () => {
  state.installEvent = null;
  flash('Installed. Open About Time from its icon.');
  render();
});

// ── Small helpers ──────────────────────────────────────────────────────────

const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const me = () => state.members.find((m) => m.id === state.meId) ?? null;

function flash(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('is-on');
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => toast.classList.remove('is-on'), 3600);
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle('is-busy', busy);
}

function friendlyError(err) {
  const message = String(err?.message ?? err ?? '');
  if (/permission-denied/.test(message)) {
    return 'Notifications were blocked. Allow them in your browser’s site settings, then try again.';
  }
  if (/push-unsupported/.test(message)) {
    return 'This browser can’t receive notifications.';
  }
  if (/push-not-configured/.test(message)) {
    return 'Notifications aren’t set up for this app yet.';
  }
  if (/anonymous/i.test(message)) {
    return 'Anonymous sign-in is switched off in Supabase. Turn it on under Authentication → Sign In / Providers.';
  }
  if (/No outing with that code/i.test(message)) {
    return 'No outing with that code. Check the six characters.';
  }
  if (/relation .* does not exist|Could not find the table|schema cache|ambiguous|Could not find the function/i.test(message)) {
    return 'The database needs updating — re-run supabase/schema.sql in the SQL editor.';
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(message)) {
    return 'Can’t reach the server. Check your connection and try again.';
  }
  if (/null is not an object|undefined is not an object|Cannot read propert/i.test(message)) {
    return 'Something went wrong on this device. Reload the page and try again.';
  }
  return message || 'Something went wrong.';
}

// ── Identity (which outing this device is in) ──────────────────────────────

function loadIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.outingId && parsed?.memberId ? parsed : null;
  } catch {
    return null;
  }
}

function saveIdentity(identity) {
  if (state.demo) return;
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    /* private mode — the session still works for this visit */
  }
}

function clearIdentity() {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* ignore */
  }
}

/** Forget the `?code=` invite in the address bar without reloading. */
function clearPrefill() {
  state.prefillCode = '';
  try {
    const params = new URLSearchParams(location.search);
    if (!params.has('code')) return;
    params.delete('code');
    const query = params.toString();
    history.replaceState({}, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch {
    /* ignore */
  }
}

/**
 * A link opens while this device is already in an outing. The phone belongs
 * to one outing at a time, so ask before swapping rather than silently
 * ignoring the invite or silently dumping the current outing.
 */
function offerJoinFromLink() {
  if (!state.prefillCode || !state.outing) return;
  if (normalizeCode(state.outing.code) === state.prefillCode) {
    clearPrefill();
    return;
  }
  state.joinSheet = { code: state.prefillCode, from: 'link' };
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  const params = new URLSearchParams(location.search);
  state.demo = params.get('demo') === '1';
  state.prefillCode = codeFromSearch(location.search);
  state.error = '';

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  state.push.supported = pushSupported();
  state.push.permission = pushPermission();
  try {
    state.push.dismissed = localStorage.getItem(PUSH_DISMISSED_KEY) === '1';
    state.push.iosHintDismissed = localStorage.getItem(IOS_HINT_KEY) === '1';
  } catch {
    state.push.dismissed = false;
    state.push.iosHintDismissed = false;
  }

  if (state.demo) {
    state.store = createDemoStore();
    if (params.get('view') === 'landing') {
      state.view = 'landing';
      render();
      return;
    }
    await beginDemo();
    offerJoinFromLink();
    render();
    return;
  }

  try {
    await ensureSession();
    state.store = createRemoteStore();
  } catch (err) {
    state.view = 'error';
    state.error = friendlyError(err);
    render();
    return;
  }

  const identity = loadIdentity();
  if (identity) {
    const restored = await openOuting(identity, { silent: true });
    if (restored) {
      startPolling();
      offerJoinFromLink();
      render();
      return;
    }
  }

  state.view = 'landing';
  render();
}

async function beginDemo() {
  state.store = state.store ?? createDemoStore();
  const { outing, memberId } = await state.store.start({ title: '', name: 'Sam', emoji: '🦉' });
  state.outing = outing;
  state.meId = memberId;
  state.view = 'outing';
  const { members } = await state.store.fetch(outing.id);
  state.members = members;
  watch();
  startPolling();
  render();
}

async function openOuting(identity, { silent = false } = {}) {
  try {
    const { outing, members } = await state.store.fetch(identity.outingId);
    if (!outing) throw new Error('That outing has ended.');
    if (!members.some((m) => m.id === identity.memberId)) {
      throw new Error('You’re no longer part of that outing.');
    }

    state.outing = outing;
    state.members = members;
    state.meId = identity.memberId;
    state.view = 'outing';
    saveIdentity({
      outingId: outing.id,
      memberId: identity.memberId,
      code: outing.code,
      title: outing.title,
    });
    watch();
    render();
    return true;
  } catch (err) {
    clearIdentity();
    state.outing = null;
    state.members = [];
    state.meId = null;
    state.joinSheet = null;
    state.help = false;
    state.view = 'landing';
    if (!silent) flash(friendlyError(err));
    render();
    return false;
  }
}

// ── Live updates ───────────────────────────────────────────────────────────

function watch() {
  if (!state.outing) return;
  state.store.watch?.(state.outing.id, scheduleRefresh);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

async function refresh() {
  if (!state.outing) return;
  try {
    const { outing, members } = await state.store.fetch(state.outing.id);
    if (!outing) {
      clearIdentity();
      state.outing = null;
      state.members = [];
      state.meId = null;
      state.joinSheet = null;
      state.help = false;
      state.view = 'landing';
      flash('That outing has ended.');
      render();
      return;
    }
    if (!members.some((m) => m.id === state.meId)) {
      clearIdentity();
      state.outing = null;
      state.members = [];
      state.meId = null;
      state.joinSheet = null;
      state.help = false;
      state.view = 'landing';
      flash('You left this outing.');
      render();
      return;
    }
    state.outing = outing;
    state.members = members;
    // A sheet may be mid-typing. Hold the render; closing the sheet repaints
    // with this fresh state.
    if (!state.joinSheet && !state.help) render();
  } catch {
    // Keep the last known state; the poll or a realtime event will retry.
  }
}

function startPolling() {
  clearInterval(pollTimer);
  // Realtime is the main path, but venue wifi is venue wifi.
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.view === 'outing') refresh();
  }, 30_000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.view === 'outing') refresh();
});

// ── Actions ────────────────────────────────────────────────────────────────

async function run(task) {
  if (state.busy) return;
  setBusy(true);
  try {
    await task();
  } catch (err) {
    flash(friendlyError(err));
  } finally {
    setBusy(false);
  }
}

async function handleStart(form) {
  const data = new FormData(form);
  const title = truncate(data.get('title') || '', 40) || 'Outing';
  const name = cleanName(data.get('name'));
  const emoji = form.querySelector('.emoji-row')?.dataset.value || '🦉';

  if (!isValidName(name)) return flash('Add your name first.');
  if (!state.store) return flash('Not connected — reload the page.');

  await run(async () => {
    const { outing, memberId } = await state.store.start({ title, name, emoji });
    state.outing = outing;
    state.meId = memberId;
    saveIdentity({ outingId: outing.id, memberId, code: outing.code, title: outing.title });
    const opened = await openOuting({ outingId: outing.id, memberId }, { silent: true });
    if (!opened) throw new Error('Outing created, but couldn’t load it. Reload the page.');
    startPolling();
    flash('Outing started. Share the code.');
  });
}

async function joinOuting({ code, name, emoji }) {
  const { outing, memberId } = await state.store.join({ code, name, emoji });
  state.outing = outing;
  state.meId = memberId;
  saveIdentity({ outingId: outing.id, memberId, code: outing.code, title: outing.title });
  const opened = await openOuting({ outingId: outing.id, memberId }, { silent: true });
  if (!opened) throw new Error('Joined, but couldn’t load the outing. Reload the page.');
  startPolling();
  return outing;
}

async function handleJoin(form) {
  const data = new FormData(form);
  const code = normalizeCode(data.get('code'));
  const name = cleanName(data.get('name'));
  const emoji = form.querySelector('.emoji-row')?.dataset.value || '🌷';

  if (!isValidCode(code)) return flash('That code should be six characters, like ABC 234.');
  if (!isValidName(name)) return flash('Add your name first.');
  if (!state.store) return flash('Not connected — reload the page.');

  await run(async () => {
    await joinOuting({ code, name, emoji });
    clearPrefill();
    flash('You’re in.');
  });
}

/**
 * Leave the current outing and join another as the same person. The sheet
 * has already asked; this is the part that cannot be undone.
 */
async function switchOuting(code) {
  const person = me();
  if (!person || !state.outing) return;

  if (normalizeCode(state.outing.code) === code) {
    state.joinSheet = null;
    clearPrefill();
    render();
    flash('You’re already in that outing.');
    return;
  }

  const previous = { id: state.outing.id, title: state.outing.title };
  const { name, emoji } = person;

  await run(async () => {
    // Join first. A mistyped or expired code should never cost the outing
    // you are already in; the old one is only left once the new one exists.
    const { outing, memberId } = await state.store.join({ code, name, emoji });

    state.joinSheet = null;
    state.store.unwatch?.();
    clearInterval(pollTimer);

    try {
      await state.store.leave(previous.id);
    } catch {
      /* best effort — the new outing is already joined */
    }

    state.outing = outing;
    state.meId = memberId;
    saveIdentity({ outingId: outing.id, memberId, code: outing.code, title: outing.title });

    const opened = await openOuting({ outingId: outing.id, memberId }, { silent: true });
    if (!opened) throw new Error('Joined, but couldn’t load the outing. Reload the page.');

    startPolling();
    clearPrefill();
    flash(`Switched from “${truncate(previous.title, 24)}”.`);
  });
}

async function handleSwitch(form) {
  const data = new FormData(form);
  const code = normalizeCode(data.get('code'));
  if (!isValidCode(code)) return flash('That code should be six characters, like ABC 234.');
  await switchOuting(code);
}

function openJoinSheet() {
  if (!state.outing) return;
  state.joinSheet = { code: '', from: 'manual' };
  render();
}

function closeSheet() {
  const wasJoin = Boolean(state.joinSheet);
  state.joinSheet = null;
  state.help = false;
  // Dismissing an invite should survive a reload; dismissing help should not
  // disturb where the person was.
  if (wasJoin) clearPrefill();
  render();
}

function openHelp() {
  state.help = true;
  render();
}

async function installApp() {
  const event = state.installEvent;
  if (!event) {
    openHelp();
    return;
  }

  // prompt() must be called inside the tap, before any await.
  event.prompt();
  state.installEvent = null;
  render();

  try {
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') flash('Installing — open About Time from its icon.');
    else flash('No problem — you can install from the browser menu later.');
  } catch {
    /* the browser owns the outcome */
  }
}

async function setBattery(value) {
  const person = me();
  if (!person) return;
  const level = nearestBattery(value);
  if (level === nearestBattery(person.battery)) return;

  state.members = state.members.map((m) =>
    m.id === person.id ? { ...m, battery: level, updated_at: new Date().toISOString() } : m,
  );
  render();

  try {
    await state.store.patchMe(person.id, { battery: level });
  } catch {
    state.members = state.members.map((m) => (m.id === person.id ? person : m));
    render();
    flash('Couldn’t save your battery — check your connection.');
  }
}

async function toggleReady() {
  const person = me();
  if (!person) return;

  const next = !person.ready;
  const readyAt = next ? new Date().toISOString() : null;

  state.members = state.members.map((m) =>
    m.id === person.id ? { ...m, ready: next, ready_at: readyAt, updated_at: new Date().toISOString() } : m,
  );
  render();

  if (next && navigator.vibrate) navigator.vibrate(14);

  try {
    await state.store.patchMe(person.id, { ready: next, ready_at: readyAt });
    if (next && state.outing) {
      // Fire-and-forget: the live screen already updated for everyone else.
      state.store.notifyReady(state.outing.id).catch(() => {});
    }
  } catch {
    state.members = state.members.map((m) => (m.id === person.id ? person : m));
    render();
    flash('Couldn’t reach the others — check your connection.');
  }
}

async function shareOuting() {
  if (!state.outing) return;
  const url = joinUrl(state.outing.code, location.href);
  const text = `Join me on ${APP_NAME} — code ${formatCode(state.outing.code)}`;

  try {
    if (navigator.share) {
      await navigator.share({ title: APP_NAME, text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    flash('Invite copied to the clipboard.');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    flash(`Couldn’t share — the code is ${formatCode(state.outing.code)}.`);
  }
}

async function leaveOuting() {
  if (!state.outing) return;
  if (!window.confirm('Leave this outing? You can rejoin with the code.')) return;

  const outingId = state.outing.id;
  state.store.unwatch?.();
  clearIdentity();
  clearInterval(pollTimer);

  state.outing = null;
  state.members = [];
  state.meId = null;
  state.joinSheet = null;
  state.help = false;
  state.view = 'landing';
  render();

  try {
    await state.store.leave(outingId);
  } catch {
    /* best effort */
  }
}

async function turnOnPush() {
  if (!state.outing) return;
  await run(async () => {
    await enablePush({
      onSubscribe: (sub) =>
        state.store.saveSubscription({ outingId: state.outing.id, ...sub }),
    });
    state.push.permission = pushPermission();
    state.help = false;
    render();
    flash('Alerts on. You’ll hear when someone’s ready.');
  });
  state.push.permission = pushPermission();
  render();
}

function dismissPush() {
  state.push.dismissed = true;
  try {
    localStorage.setItem(PUSH_DISMISSED_KEY, '1');
  } catch {
    /* ignore */
  }
  render();
}

function dismissIosHint() {
  state.push.iosHintDismissed = true;
  try {
    localStorage.setItem(IOS_HINT_KEY, '1');
  } catch {
    /* ignore */
  }
  render();
}

// ── Rendering ──────────────────────────────────────────────────────────────

function render() {
  document.body.dataset.view = state.view;
  const sheetOpen = Boolean(state.joinSheet || state.help);
  document.body.classList.toggle('is-sheeted', sheetOpen);

  const view =
    state.view === 'outing'
      ? outingHtml()
      : state.view === 'error'
        ? errorHtml()
        : state.view === 'landing'
          ? landingHtml()
          : bootHtml();

  app.innerHTML = view + joinSheetHtml() + helpSheetHtml();
  focusSheet(sheetOpen);
}

/**
 * Move focus into a sheet once, when it first opens. Re-focusing on every
 * realtime render would steal the caret mid-typing.
 */
function focusSheet(sheetOpen) {
  if (!sheetOpen) {
    lastSheetFocus = '';
    return;
  }

  const key = state.joinSheet ? `join:${state.joinSheet.from}` : 'help';
  if (key === lastSheetFocus) return;
  lastSheetFocus = key;

  const target =
    state.joinSheet?.from === 'manual'
      ? app.querySelector('[data-form="switch"] input[name="code"]')
      : app.querySelector('.sheet');
  target?.focus({ preventScroll: true });
}

function markSvg(size = 56) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="at-mark" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#F08A4B"/>
        <stop offset="1" stop-color="#D9502B"/>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="62" height="62" rx="17" fill="url(#at-mark)"/>
    <rect x="13" y="26" width="32" height="20" rx="5.5" fill="none" stroke="#FFF6EA" stroke-width="3.2"/>
    <rect x="48" y="31.5" width="5" height="9" rx="2.2" fill="#FFF6EA"/>
    <rect x="18.5" y="31" width="6" height="10" rx="1.8" fill="#FFF6EA"/>
    <rect x="27.5" y="31" width="6" height="10" rx="1.8" fill="#FFF6EA" opacity="0.55"/>
    <rect x="36.5" y="31" width="6" height="10" rx="1.8" fill="#FFF6EA" opacity="0.22"/>
  </svg>`;
}

function bootHtml() {
  return `<main class="boot"><div class="boot-mark">${markSvg(64)}</div><p>Finding your people…</p></main>`;}

function errorHtml() {
  return `<main class="narrow">
    <div class="hero compact"><div class="mark-wrap">${markSvg(56)}</div><h1>${APP_NAME}</h1></div>
    <section class="card">
      <h2>Couldn’t start</h2>
      <p class="muted">${esc(state.error)}</p>
      <button class="btn btn-primary" data-action="retry">Try again</button>
    </section>
  </main>`;
}

function emojiRow(group, selected) {
  return `<div class="emoji-row" data-group="${group}" data-value="${esc(selected)}">
    ${EMOJIS.map(
      (emoji, index) => `<button type="button" class="emoji ${emoji === selected ? 'is-on' : ''}"
        data-action="emoji" data-emoji="${esc(emoji)}" aria-pressed="${emoji === selected}"
        aria-label="Face ${index + 1}">${emoji}</button>`,
    ).join('')}
  </div>`;
}

function landingHtml() {
  const invited = Boolean(state.prefillCode);

  const startCard = `<section class="card">
    <h2>Start an outing</h2>
    <form data-form="start" autocomplete="off">
      <label class="field">
        <span>Occasion</span>
        <input name="title" maxlength="40" placeholder="Sunday service" enterkeyhint="next">
      </label>
      <label class="field">
        <span>Your name</span>
        <input name="name" maxlength="24" placeholder="Dad" required enterkeyhint="next">
      </label>
      <div class="field">
        <span class="field-label">Your face</span>
        ${emojiRow('start', '🦉')}
      </div>
      <button class="btn btn-primary" type="submit">Start the outing</button>
    </form>
  </section>`;

  const joinCard = `<section class="card${invited ? ' card-invite' : ''}">
    ${invited ? '<p class="eyebrow">You’ve been invited</p>' : ''}
    <h2>Join an outing</h2>
    <form data-form="join" autocomplete="off">
      <label class="field">
        <span>Code</span>
        <input name="code" value="${esc(state.prefillCode)}" maxlength="7" placeholder="ABC 234"
          autocapitalize="characters" spellcheck="false" required enterkeyhint="next">
      </label>
      <label class="field">
        <span>Your name</span>
        <input name="name" maxlength="24" placeholder="Mum" required enterkeyhint="next">
      </label>
      <div class="field">
        <span class="field-label">Your face</span>
        ${emojiRow('join', '🌷')}
      </div>
      <button class="btn ${invited ? 'btn-primary' : 'btn-ghost'}" type="submit">Join</button>
    </form>
  </section>`;

  return `<div class="narrow">
    <header class="hero">
      <div class="mark-wrap">${markSvg(64)}</div>
      <h1>${APP_NAME}</h1>
      <p class="tagline">${esc(APP_TAGLINE)}</p>
    </header>

    <main class="stack">
      ${
        invited
          ? `${joinCard}<div class="or"><span>or</span></div>${startCard}`
          : `${startCard}<div class="or"><span>or</span></div>${joinCard}`
      }
    </main>

    <p class="fineprint">
      No accounts, no passwords. Just a code.
      <span class="fineprint-links">
        <button class="link" data-action="demo">Preview with demo data</button>
        <span aria-hidden="true">·</span>
        <button class="link" data-action="show-help">Alerts &amp; install</button>
      </span>
      <span class="version">v${esc(APP_VERSION)}</span>
    </p>
  </div>`;
}

function batteryPicker(value) {
  const levels = [0, 25, 50, 75, 100];
  const current = nearestBattery(value);

  return `<div class="battery-picker" role="group" aria-label="How much social battery do you have left?">
    ${levels
      .map((level) => {
        const filled = batterySegments(level);
        const on = level === current;
        return `<button type="button" class="level ${on ? 'is-on' : ''}" data-action="battery"
          data-value="${level}" aria-pressed="${on}">
          <span class="level-glyph" aria-hidden="true">${[0, 1, 2, 3, 4]
            .map((i) => `<i class="${i < filled ? 'on' : ''}"></i>`)
            .join('')}</span>
          <span class="level-label">${batteryLabel(level)}</span>
        </button>`;
      })
      .join('')}
  </div>`;
}

function miniBattery(value) {
  const filled = batterySegments(value);
  return `<span class="mini-battery" aria-hidden="true">${[0, 1, 2, 3, 4]
    .map((i) => `<i class="${i < filled ? 'on' : ''}"></i>`)
    .join('')}</span>`;
}

function personHtml(person) {
  const isMe = person.id === state.meId;
  const when = person.ready && person.ready_at ? relativeTime(person.ready_at) : '';

  return `<li class="person ${person.ready ? 'is-ready' : ''}">
    <span class="avatar sm">${esc(person.emoji)}</span>
    <div class="person-main">
      <p class="person-name">${esc(person.name)}${isMe ? ' <span class="you">you</span>' : ''}
        ${when ? `<span class="when">· ${esc(when)}</span>` : ''}
      </p>
      ${miniBattery(person.battery)}
    </div>
    <span class="pill ${person.ready ? 'pill-ready' : ''}">${person.ready ? 'Ready' : batteryLabel(person.battery)}</span>
  </li>`;
}

// ── Alerts & install help ──────────────────────────────────────────────────
// The notification story differs by platform, and the browser's own prompt is
// the least self-explanatory part of the app. These helpers answer the three
// questions a person actually asks: is it on, how do I install this, and why
// isn't it arriving?

/** Apple only delivers Web Push to an installed app, never a Safari tab. */
function needsHomeScreenForPush() {
  return (isIOS() || isSafari()) && !isStandalone();
}

function installSteps() {
  if (isIOS()) {
    return [
      'Open this page in <strong>Safari</strong>.',
      'Tap the <strong>Share</strong> button — the square with an arrow.',
      'Choose <strong>Add to Home Screen</strong>, then open About Time from the new icon.',
    ];
  }
  if (isSafari()) {
    return [
      'In Safari, choose <strong>File → Add to Dock</strong>.',
      'Open About Time from the Dock.',
    ];
  }
  if (browserName() === 'Firefox') {
    return isAndroid()
      ? [
          'Tap the <strong>⋮</strong> menu in Firefox.',
          'Choose <strong>Add to Home screen</strong>.',
          'Open About Time from the new icon.',
        ]
      : [
          'Firefox on a computer doesn’t install web apps.',
          'Bookmark this page instead — alerts still work in a normal tab.',
        ];
  }
  if (isAndroid()) {
    return [
      'Open this page in <strong>Chrome</strong>.',
      'Tap the <strong>⋮</strong> menu, then <strong>Add to Home screen</strong> (or <strong>Install app</strong>).',
      'Open About Time from the new icon.',
    ];
  }
  return [
    'Click the <strong>install icon</strong> at the right of the address bar — a small screen with an arrow.',
    'Or open the browser menu <strong>⋮ → Save and share → Install page as app</strong>.',
    'Open About Time from its icon.',
  ];
}

function installNote() {
  if (isStandalone()) return 'Already installed — open it from its icon.';
  if (isIOS()) {
    return 'On iPhone this is required for alerts: Safari only delivers notifications to a Home Screen app.';
  }
  if (isSafari()) {
    return 'On a Mac, Safari only delivers notifications to a web app added to the Dock.';
  }
  if (browserName() === 'Firefox') {
    return isAndroid()
      ? 'Optional — alerts work in a normal tab too.'
      : 'Firefox can’t install this as an app on a computer; a bookmark works just as well, and alerts work in a normal tab.';
  }
  if (isAndroid()) {
    return 'Optional, but it opens full-screen and puts the icon on your home screen. Alerts also work in a Chrome tab.';
  }
  return 'Optional, but it opens in its own window and keeps the icon a click away. Alerts also work in a normal tab.';
}

function unblockSteps() {
  if (isIOS()) {
    if (!isStandalone()) {
      return [
        'Add About Time to the Home Screen first — iPhone only sends alerts to Home Screen apps.',
        'Open it from the icon, then tap <strong>Turn on alerts</strong> and allow.',
      ];
    }
    return [
      'Open the iPhone <strong>Settings</strong> app.',
      'Tap <strong>Notifications → About Time</strong>.',
      'Turn on <strong>Allow Notifications</strong>.',
    ];
  }

  const browser = browserName();

  if (browser === 'Chrome' || browser === 'Edge' || browser === 'Opera') {
    return isAndroid()
      ? [
          'Tap the <strong>tune</strong> icon (or padlock) at the start of the address bar.',
          'Tap <strong>Permissions → Notifications</strong>.',
          'Choose <strong>Allow</strong>, then reload this page.',
        ]
      : [
          'Click the <strong>tune</strong> icon (or padlock) at the start of the address bar.',
          'Set <strong>Notifications</strong> to <strong>Allow</strong>.',
          'Reload this page.',
        ];
  }
  if (browser === 'Safari') {
    return [
      'In Safari, open <strong>Settings for This Website</strong> from the address field.',
      'Set <strong>Notifications</strong> to <strong>Allow</strong>.',
      'Reload this page.',
    ];
  }
  if (browser === 'Firefox') {
    return [
      'Click the <strong>padlock</strong> in the address bar.',
      'Clear the blocked permission for <strong>Notifications</strong>.',
      'Reload and choose <strong>Allow</strong> when asked.',
    ];
  }
  return [
    `Open this page’s site settings in ${esc(browser)}.`,
    'Allow notifications for this site.',
    'Reload this page.',
  ];
}

function alertsHelpStatusHtml() {
  if (!state.push.supported) {
    return `<p class="muted">This browser can’t receive Web Push.${
      isIOS()
        ? ' On iPhone you need iOS 16.4 or later.'
        : ' Chrome, Edge, Firefox and Safari on a computer all can.'
    }</p>`;
  }

  if (state.push.permission === 'granted') {
    return '<p class="hint-ok">Alerts are on for this device.</p>';
  }

  if (state.push.permission === 'denied') {
    return `<p class="muted"><strong>Blocked.</strong> Allow them in ${esc(browserName())}:</p>
      <ol class="steps">${unblockSteps().map((step) => `<li>${step}</li>`).join('')}</ol>`;
  }

  if (!state.outing) {
    return '<p class="muted">Join or start an outing first — alerts are switched on from inside it.</p>';
  }

  if (needsHomeScreenForPush()) {
    return `<p class="muted">Apple only delivers notifications to the installed app. Add it to your ${
      isIOS() ? 'Home Screen' : 'Dock'
    } first, then tap <strong>Turn on alerts</strong> from the icon.</p>`;
  }

  return `<p class="muted">Tap <strong>Turn on alerts</strong>. Your browser will ask permission — choose <strong>Allow</strong>. The prompt only appears once, and only after a tap like this.</p>
    <button class="btn btn-primary" data-action="enable-push">Turn on alerts</button>`;
}

function pushCardHtml() {
  if (!state.outing) return '';

  // No Push API at all. On Apple platforms that usually means an old iOS, or
  // Safari in a tab where Web Push is deliberately missing.
  if (!state.push.supported) {
    if (needsHomeScreenForPush()) {
      return `<section class="card push">
        <h2>Add to ${isIOS() ? 'Home Screen' : 'Dock'} to get alerts</h2>
        <ol class="steps">${installSteps().map((step) => `<li>${step}</li>`).join('')}</ol>
        <p class="muted">${installNote()}</p>
        <button class="link" data-action="show-help">How alerts &amp; install work</button>
      </section>`;
    }
    return `<section class="card push">
      <h2>Alerts aren’t available in this browser</h2>
      <p class="muted">${
        isIOS()
          ? 'iPhone needs iOS 16.4 or later.'
          : 'Chrome, Edge, Firefox and Safari on a computer can all receive them.'
      }</p>
      <button class="link" data-action="show-help">How alerts work</button>
    </section>`;
  }

  if (state.push.permission === 'granted') {
    return `<p class="alert-status">Alerts on for this device.
      <button class="link" data-action="show-help">Not getting them?</button></p>`;
  }

  if (needsHomeScreenForPush()) {
    if (state.push.iosHintDismissed) {
      return `<p class="alert-status alert-status-off">Alerts need the installed app.
        <button class="link" data-action="show-help">How</button></p>`;
    }
    return `<section class="card push">
      <h2>Add to ${isIOS() ? 'Home Screen' : 'Dock'} to get alerts</h2>
      <ol class="steps">${installSteps().map((step) => `<li>${step}</li>`).join('')}</ol>
      <p class="muted">${installNote()}</p>
      <div class="push-links">
        <button class="link" data-action="show-help">Full instructions</button>
        <button class="link" data-action="dismiss-ios-hint">Not now</button>
      </div>
    </section>`;
  }

  if (state.push.permission === 'denied') {
    return `<section class="card push">
      <h2>Alerts are blocked</h2>
      <p class="muted">Allow notifications for this page and they’ll arrive even when the app is closed.</p>
      <ol class="steps">${unblockSteps().map((step) => `<li>${step}</li>`).join('')}</ol>
      <button class="link" data-action="show-help">More help with alerts</button>
    </section>`;
  }

  if (state.push.dismissed) {
    return `<p class="alert-status alert-status-off">Alerts are off.
      <button class="link" data-action="enable-push">Turn them on</button>
      <span aria-hidden="true">·</span>
      <button class="link" data-action="show-help">How</button></p>`;
  }

  return `<section class="card push">
    <h2>Get a nudge when someone’s ready</h2>
    <p class="muted">One quiet notification, even with the app closed. Your browser will ask permission — choose <strong>Allow</strong>.</p>
    <button class="btn btn-primary" data-action="enable-push">Turn on alerts</button>
    <div class="push-links">
      <button class="link" data-action="show-help">How alerts &amp; install work</button>
      <button class="link" data-action="dismiss-push">Not now</button>
    </div>
  </section>`;
}

/** Chrome exposes a real install prompt; offer it rather than describing a menu. */
function installCardHtml() {
  if (!state.installEvent || isStandalone()) return '';
  const alertsSettled = state.push.permission === 'granted' || state.push.dismissed;
  if (!alertsSettled) return '';

  return `<section class="card push">
    <h2>Install About Time</h2>
    <p class="muted">Opens full-screen and puts the icon where you can find it. Alerts work either way in ${esc(browserName())}.</p>
    <button class="btn btn-ghost" data-action="install">Install app</button>
  </section>`;
}

function joinSheetHtml() {
  const sheet = state.joinSheet;
  if (!sheet || !state.outing) return '';

  const person = me();
  const fromLink = sheet.from === 'link';

  return `<div class="sheet-backdrop" data-sheet-backdrop>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="join-sheet-title" tabindex="-1">
      <div class="sheet-head">
        <div>
          <p class="eyebrow">${fromLink ? 'You’re invited' : 'Switch outings'}</p>
          <h2 id="join-sheet-title">${
            fromLink ? `Join ${esc(formatCode(sheet.code))}?` : 'Join a different outing'
          }</h2>
        </div>
        <button class="sheet-close" data-action="close-sheet" aria-label="Close">✕</button>
      </div>

      <p class="muted">You’re in <strong>${esc(state.outing.title)}</strong>. Joining another outing takes you out of this one.</p>

      <form data-form="switch" autocomplete="off">
        <label class="field">
          <span>Code</span>
          <input name="code" value="${esc(formatCode(sheet.code))}" maxlength="7" placeholder="ABC 234"
            autocapitalize="characters" spellcheck="false" required enterkeyhint="go">
        </label>
        ${person ? `<p class="sheet-note">You’ll join as <strong>${esc(person.emoji)} ${esc(person.name)}</strong>.</p>` : ''}
        <button class="btn btn-primary" type="submit">Leave &amp; join</button>
        <button class="btn btn-ghost" type="button" data-action="close-sheet">Stay here</button>
      </form>
    </section>
  </div>`;
}

function helpSheetHtml() {
  if (!state.help) return '';

  return `<div class="sheet-backdrop" data-sheet-backdrop>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="help-title" tabindex="-1">
      <div class="sheet-head">
        <div>
          <p class="eyebrow">${APP_NAME}</p>
          <h2 id="help-title">Alerts &amp; install</h2>
        </div>
        <button class="sheet-close" data-action="close-sheet" aria-label="Close">✕</button>
      </div>

      <div class="sheet-body">
        <section class="help-block">
          <h3>What alerts do</h3>
          <p class="muted">When someone taps “I’m ready to go”, everyone else’s phone gets one quiet notification — even with the app closed. Battery changes never notify.</p>
        </section>

        <section class="help-block">
          <h3>On this device</h3>
          ${alertsHelpStatusHtml()}
        </section>

        <section class="help-block">
          <h3>Install it like an app</h3>
          <p class="muted">${installNote()}</p>
          <ol class="steps">${installSteps().map((step) => `<li>${step}</li>`).join('')}</ol>
          ${state.installEvent ? '<button class="btn btn-ghost" data-action="install">Install app</button>' : ''}
        </section>

        <section class="help-block">
          <h3>Nothing arriving?</h3>
          <ol class="steps">
            <li>Check the phone’s own settings — notifications on, not muted, and not in a Focus mode.</li>
            <li>Allow notifications for this site in ${esc(browserName())}.</li>
            <li>If you switched phones, turn alerts on again on the new one.</li>
          </ol>
        </section>
      </div>

      <p class="version">${APP_NAME} v${esc(APP_VERSION)} · ${esc(browserName())}${
        isStandalone() ? ' · installed' : ''
      }</p>
    </section>
  </div>`;
}

function outingHtml() {
  const person = me();
  if (!person || !state.outing) return landingHtml();

  const summary = readySummary(state.members);
  const people = sortMembers(state.members);
  const code = formatCode(state.outing.code);

  return `<main class="narrow">
    ${
      state.demo
        ? `<div class="demo-banner"><span>Demo mode — these people aren’t real.</span><a href="./">Use the real app</a></div>`
        : ''
    }
    <header class="topbar">
      <div class="topbar-copy">
        <p class="eyebrow">Outing</p>
        <h1>${esc(state.outing.title)}</h1>
      </div>
      <button class="icon-btn" data-action="share" aria-label="Share the invite">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>
        </svg>
      </button>
    </header>

    <button class="code-chip" data-action="share">
      <span class="code-chip-label">Code</span>
      <span class="code-chip-value">${esc(code)}</span>
      <span class="code-chip-hint">tap to share</span>
    </button>

    <section class="summary ${summary.anyoneReady ? 'is-live' : ''}">
      <div class="summary-row">
        <p class="summary-count"><strong>${summary.ready}</strong><span>/${summary.total}</span></p>
        <p class="summary-text">${esc(summaryText(summary))}</p>
      </div>
      <div class="dots" aria-hidden="true">
        ${state.members
          .map((m) => `<span class="dot ${m.ready ? 'on' : ''}" title="${esc(m.name)}"></span>`)
          .join('')}
      </div>
    </section>

    <section class="card me ${person.ready ? 'is-ready' : ''}">
      <div class="me-head">
        <span class="avatar">${esc(person.emoji)}</span>
        <div class="me-who">
          <p class="me-name">${esc(person.name)}</p>
          <p class="me-sub">That’s you</p>
        </div>
      </div>

      <div class="battery">
        <div class="battery-head">
          <span>Social battery</span>
          <span class="battery-value">${batteryLabel(person.battery)}</span>
        </div>
        ${batteryPicker(person.battery)}
      </div>

      <button type="button" class="btn-ready ${person.ready ? 'is-on' : ''}" data-action="toggle-ready">
        <span class="btn-ready-main">${person.ready ? 'You’re ready to go' : 'I’m ready to go'}</span>
        <span class="btn-ready-sub">${person.ready ? 'Tap again to stay a bit longer' : 'This nudges everyone else'}</span>
      </button>
    </section>

    <section class="people">
      <div class="people-head">
        <h2>Everyone</h2>
        <span class="muted">${summary.total} here</span>
      </div>
      <ul>${people.map(personHtml).join('')}</ul>
    </section>

    ${pushCardHtml()}
    ${installCardHtml()}

    <footer class="outro">
      ${state.demo ? '<span class="badge">Demo data</span>' : ''}
      <div class="outro-links">
        <button class="link" data-action="switch-outing">Join a different outing</button>
        <span aria-hidden="true">·</span>
        <button class="link" data-action="show-help">Alerts &amp; install</button>
        <span aria-hidden="true">·</span>
        <button class="link" data-action="leave">Leave</button>
      </div>
      <span class="version">${APP_NAME} v${esc(APP_VERSION)}</span>
    </footer>
  </main>`;
}

// ── Events ─────────────────────────────────────────────────────────────────

app.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.form === 'start') handleStart(form);
  else if (form.dataset.form === 'join') handleJoin(form);
  else if (form.dataset.form === 'switch') handleSwitch(form);
});

app.addEventListener('click', (event) => {
  // A tap on the dimmed backdrop closes the sheet; a tap inside does not.
  const backdrop = event.target.closest('[data-sheet-backdrop]');
  if (backdrop && event.target === backdrop) {
    closeSheet();
    return;
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;

  switch (target.dataset.action) {
    case 'emoji': {
      const row = target.closest('.emoji-row');
      if (!row) break;
      row.dataset.value = target.dataset.emoji;
      row.querySelectorAll('.emoji').forEach((button) => {
        const on = button === target;
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-pressed', String(on));
      });
      break;
    }
    case 'battery':
      setBattery(Number(target.dataset.value));
      break;
    case 'toggle-ready':
      toggleReady();
      break;
    case 'share':
      shareOuting();
      break;
    case 'leave':
      leaveOuting();
      break;
    case 'enable-push':
      turnOnPush();
      break;
    case 'dismiss-push':
      dismissPush();
      break;
    case 'dismiss-ios-hint':
      dismissIosHint();
      break;
    case 'switch-outing':
      openJoinSheet();
      break;
    case 'show-help':
      openHelp();
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'install':
      installApp();
      break;
    case 'retry':
      boot();
      break;
    case 'demo':
      state.demo = true;
      state.store = createDemoStore();
      beginDemo();
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!state.joinSheet && !state.help) return;
  event.preventDefault();
  closeSheet();
});

// ── Go ─────────────────────────────────────────────────────────────────────

boot();
