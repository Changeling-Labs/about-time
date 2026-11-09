// About Time — app shell.
//
// Vanilla ES modules, no build step. State lives in one object; every mutation
// ends in render(). The only text inputs live on the landing screen, so a full
// re-render never steals focus mid-typing.

import { APP_NAME, APP_TAGLINE } from './config.js';
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
  enablePush,
  isIOS,
  isStandalone,
  permission as pushPermission,
  pushSupported,
} from './push.js';

const IDENTITY_KEY = 'about-time.identity.v1';
const PUSH_DISMISSED_KEY = 'about-time.push-dismissed.v1';
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
  push: { supported: false, permission: 'default', dismissed: false },
};

const app = document.getElementById('app');
const toast = document.getElementById('toast');

let refreshTimer = null;
let pollTimer = null;

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
  if (/anonymous/i.test(message)) {
    return 'Anonymous sign-in is switched off in Supabase. Turn it on under Authentication → Sign In / Providers.';
  }
  if (/No outing with that code/i.test(message)) {
    return 'No outing with that code. Check the six characters.';
  }
  if (/relation .* does not exist|Could not find the table|schema cache/i.test(message)) {
    return 'The database isn’t set up yet — run supabase/schema.sql in the SQL editor.';
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
  } catch {
    state.push.dismissed = false;
  }

  if (state.demo) {
    state.store = createDemoStore();
    if (params.get('view') === 'landing') {
      state.view = 'landing';
      render();
      return;
    }
    await beginDemo();
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
      state.view = 'landing';
      flash('You left this outing.');
      render();
      return;
    }
    state.outing = outing;
    state.members = members;
    render();
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
    await openOuting({ outingId: outing.id, memberId }, { silent: true });
    startPolling();
    flash('Outing started. Share the code.');
  });
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
    const { outing, memberId } = await state.store.join({ code, name, emoji });
    state.outing = outing;
    state.meId = memberId;
    saveIdentity({ outingId: outing.id, memberId, code: outing.code, title: outing.title });
    await openOuting({ outingId: outing.id, memberId }, { silent: true });
    startPolling();
    flash('You’re in.');
  });
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

// ── Rendering ──────────────────────────────────────────────────────────────

function render() {
  document.body.dataset.view = state.view;
  app.innerHTML =
    state.view === 'outing'
      ? outingHtml()
      : state.view === 'error'
        ? errorHtml()
        : state.view === 'landing'
          ? landingHtml()
          : bootHtml();
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
  return `<div class="narrow">
    <header class="hero">
      <div class="mark-wrap">${markSvg(64)}</div>
      <h1>${APP_NAME}</h1>
      <p class="tagline">${esc(APP_TAGLINE)}</p>
    </header>

    <main class="stack">
      <section class="card">
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
      </section>

      <div class="or"><span>or</span></div>

      <section class="card">
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
          <button class="btn btn-ghost" type="submit">Join</button>
        </form>
      </section>
    </main>

    <p class="fineprint">
      No accounts, no passwords. Just a code.
      <button class="link" data-action="demo">Preview with demo data</button>
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

function pushCardHtml() {
  if (!state.outing || !state.push.supported) return '';
  if (state.push.permission === 'granted' || state.push.dismissed) return '';

  if (state.push.permission === 'denied') {
    return `<section class="card push">
      <h2>Alerts are blocked</h2>
      <p class="muted">Your browser is blocking notifications for this site. You can re-enable them in its settings.</p>
      <button class="btn btn-ghost" data-action="dismiss-push">Dismiss</button>
    </section>`;
  }

  if (isIOS() && !isStandalone()) {
    return `<section class="card push">
      <h2>Add to Home Screen for alerts</h2>
      <p class="muted">On iPhone, tap Share → <strong>Add to Home Screen</strong>, then open ${APP_NAME} from the icon and turn alerts on.</p>
      <button class="btn btn-ghost" data-action="dismiss-push">Not now</button>
    </section>`;
  }

  return `<section class="card push">
    <h2>Get a nudge</h2>
    <p class="muted">A quiet notification when someone is ready to go — even with the app closed.</p>
    <button class="btn btn-primary" data-action="enable-push">Turn on alerts</button>
    <button class="btn btn-ghost" data-action="dismiss-push">Not now</button>
  </section>`;
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

    <footer class="outro">
      ${state.demo ? '<span class="badge">Demo data</span>' : ''}
      <button class="link" data-action="leave">Leave this outing</button>
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
});

app.addEventListener('click', (event) => {
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

// ── Go ─────────────────────────────────────────────────────────────────────

boot();
