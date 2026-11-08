// About Time — pure helpers.
//
// No DOM, no network. Everything here is unit-tested in test/lib.test.js so the
// fiddly bits (room codes, battery levels, ordering) never regress.

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Strip formatting, uppercase, and cap at six characters. */
export function normalizeCode(input = '') {
  return String(input)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

/** "ABC123" → "ABC 123" for display. */
export function formatCode(input = '') {
  const code = normalizeCode(input);
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function isCompleteCode(input = '') {
  return normalizeCode(input).length === CODE_LENGTH;
}

export function isValidCode(input = '') {
  return CODE_RE.test(normalizeCode(input));
}

// ── Battery ────────────────────────────────────────────────────────────────
// Five taps, not a slider: faster at a loud reception and impossible to fumble.

export const BATTERY_STEPS = [100, 75, 50, 25, 0];

const BATTERY_LABELS = new Map([
  [100, 'Full'],
  [75, 'Good'],
  [50, 'Half'],
  [25, 'Low'],
  [0, 'Empty'],
]);

const BATTERY_SEGMENTS = new Map([
  [100, 5],
  [75, 4],
  [50, 3],
  [25, 2],
  [0, 0],
]);

/** Snap any 0–100 value to the nearest of the five steps. */
export function nearestBattery(value) {
  const n = Number.isFinite(Number(value)) ? Number(value) : 100;
  let best = BATTERY_STEPS[0];
  for (const step of BATTERY_STEPS) {
    if (Math.abs(step - n) < Math.abs(best - n)) best = step;
  }
  return best;
}

export function batteryLabel(value) {
  return BATTERY_LABELS.get(nearestBattery(value)) ?? 'Full';
}

export function batterySegments(value) {
  return BATTERY_SEGMENTS.get(nearestBattery(value)) ?? 5;
}

// ── People ─────────────────────────────────────────────────────────────────

export function cleanName(input = '') {
  return String(input).replace(/\s+/g, ' ').trim().slice(0, 24);
}

export function isValidName(input = '') {
  return cleanName(input).length > 0;
}

/**
 * Ready people float to the top; within each group the emptiest battery wins,
 * because that is the person whose evening is about to end.
 */
export function sortMembers(members = []) {
  return [...members].sort((a, b) => {
    const aReady = a?.ready ? 1 : 0;
    const bReady = b?.ready ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady;

    const aBattery = Number.isFinite(Number(a?.battery)) ? Number(a.battery) : 100;
    const bBattery = Number.isFinite(Number(b?.battery)) ? Number(b.battery) : 100;
    if (aBattery !== bBattery) return aBattery - bBattery;

    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  });
}

export function readySummary(members = []) {
  const list = Array.isArray(members) ? members : [];
  const ready = list.filter((m) => m?.ready);
  return {
    ready: ready.length,
    total: list.length,
    names: ready.map((m) => m.name).filter(Boolean),
    allReady: list.length > 0 && ready.length === list.length,
    anyoneReady: ready.length > 0,
  };
}

export function summaryText(summary) {
  if (!summary || summary.total === 0) return 'Waiting for people to join';
  if (summary.allReady) return 'Everyone is ready';
  if (summary.ready === 0) return 'Nobody is ready yet';
  if (summary.ready === 1) return '1 person is ready';
  return `${summary.ready} people are ready`;
}

/** "just now", "3m ago", "2h ago". */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

/** Copy for the Web Push notification. */
export function readyNotification({ name, readyCount, total, title } = {}) {
  const who = cleanName(name) || 'Someone';
  const count = Number.isFinite(Number(readyCount)) ? Number(readyCount) : 1;
  const people = Number.isFinite(Number(total)) ? Number(total) : count;

  const status =
    count <= 1 ? 'Nobody else is ready yet' : `${count} of ${people} are ready`;

  return {
    title: `${who} is ready to go`,
    body: title ? `${status} · ${title}` : status,
  };
}

/** Build a shareable join link that survives being opened from a chat app. */
export function joinUrl(code, base) {
  const root = String(base ?? '').split('?')[0].split('#')[0];
  return `${root}?code=${normalizeCode(code)}`;
}

/** Read a room code out of a URL query string. */
export function codeFromSearch(search = '') {
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
    const raw = params.get('code') ?? '';
    return isValidCode(raw) ? normalizeCode(raw) : '';
  } catch {
    return '';
  }
}

/** "Ruth & Tom's wedding" → "Ruth & Tom's…" for tight notification titles. */
export function truncate(text, max = 40) {
  const value = String(text ?? '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
