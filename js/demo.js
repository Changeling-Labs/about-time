// About Time — in-memory demo store.
//
// Lets the whole interface be explored (and screenshotted) with no Supabase
// project, and gives the realtime behaviour something to show: another member
// becomes ready a few seconds after you start poking around.

import { cleanName } from './lib.js';

const iso = () => new Date().toISOString();
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function fixture(name, emoji) {
  return {
    outing: { id: 'demo-outing', code: 'WED234', title: "Ruth & Tom's wedding" },
    members: [
      {
        id: 'me',
        user_id: 'demo-me',
        name: cleanName(name) || 'You',
        emoji,
        battery: 75,
        ready: false,
        ready_at: null,
        created_at: iso(),
        updated_at: iso(),
      },
      {
        id: 'm-mum',
        user_id: 'demo-mum',
        name: 'Mum',
        emoji: '🌷',
        battery: 50,
        ready: false,
        ready_at: null,
        created_at: iso(),
        updated_at: ago(4 * 60_000),
      },
      {
        id: 'm-dad',
        user_id: 'demo-dad',
        name: 'Dad',
        emoji: '🎩',
        battery: 100,
        ready: false,
        ready_at: null,
        created_at: iso(),
        updated_at: ago(2 * 60_000),
      },
      {
        id: 'm-grace',
        user_id: 'demo-grace',
        name: 'Grace',
        emoji: '🐝',
        battery: 25,
        ready: false,
        ready_at: null,
        created_at: iso(),
        updated_at: ago(90_000),
      },
      {
        id: 'm-noah',
        user_id: 'demo-noah',
        name: 'Noah',
        emoji: '🚀',
        battery: 75,
        ready: false,
        ready_at: null,
        created_at: iso(),
        updated_at: ago(30_000),
      },
    ],
  };
}

export function createDemoStore() {
  let data = fixture('You', '🦉');
  let onChange = null;
  let timers = [];

  const touch = () => {
    if (onChange) onChange();
  };

  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const patchMember = (id, patch) => {
    data.members = data.members.map((m) =>
      m.id === id ? { ...m, ...patch, updated_at: iso() } : m,
    );
  };

  const beginShow = () => {
    clearTimers();
    // Grace has had enough of the speeches.
    timers.push(
      setTimeout(() => {
        patchMember('m-grace', { ready: true, ready_at: iso() });
        touch();
      }, 9_000),
    );
    // Dad's battery drains through the toasts.
    timers.push(
      setTimeout(() => {
        patchMember('m-dad', { battery: 50 });
        touch();
      }, 16_000),
    );
    // Mum follows Grace.
    timers.push(
      setTimeout(() => {
        patchMember('m-mum', { ready: true, ready_at: iso() });
        touch();
      }, 24_000),
    );
  };

  return {
    async start({ title, name, emoji }) {
      data = fixture(name, emoji);
      if (cleanName(title)) data.outing.title = cleanName(title);
      beginShow();
      return { outing: { ...data.outing }, memberId: 'me' };
    },

    async join({ name, emoji }) {
      data = fixture(name, emoji);
      beginShow();
      return { outing: { ...data.outing }, memberId: 'me' };
    },

    async fetch() {
      return {
        outing: { ...data.outing },
        members: data.members.map((m) => ({ ...m })),
      };
    },

    async patchMe(memberId, patch) {
      patchMember(memberId, patch);
      touch();
      return data.members.find((m) => m.id === memberId) ?? null;
    },

    watch(_outingId, cb) {
      onChange = cb;
      return { id: 'demo' };
    },

    unwatch() {
      onChange = null;
      clearTimers();
    },

    async leave() {
      clearTimers();
      onChange = null;
    },

    async saveSubscription() {
      // Nothing to do without a push service.
    },

    async notifyReady() {
      // Pretend the push went out.
    },
  };
}
