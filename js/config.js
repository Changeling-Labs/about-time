// About Time — public client configuration.
//
// These values ship in the static bundle and are safe to publish (exactly the
// same model as Pulse). The service_role key is NEVER used here.
//
// Host project: Pulse (shared Supabase project — free tier allows two).
// All About Time objects are prefixed `at_` and are isolated by row-level
// security; nothing here can read Pulse's data.
export const SUPABASE_URL = 'https://kjlmkjkzbbnzdpvjhkxz.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_5w93zJNuHD9GtNFy4x71ZQ_BgrEDm-1';

// Web Push application server key (VAPID public half). The private half lives
// only in Supabase Edge Function secrets — see supabase/README.md.
export const VAPID_PUBLIC_KEY =
  'BGmrJjIFCMzUZc2604j3rePyDCjloomhflTaefCwGH_QmK_3BWTKSChe3luBnXblK-KCHxq1D29HhQs2hlEb2Ng';

export const APP_NAME = 'About Time';
export const APP_TAGLINE = 'Everyone knows when it’s time.';
export const EDGE_FUNCTION = 'notify-ready';

// Shown quietly in the UI and in the Help sheet. Keep it in step with
// package.json (test/version.test.js enforces it) and bump the service-worker
// CACHE in sw.js on every release.
export const APP_VERSION = '0.2.0';
