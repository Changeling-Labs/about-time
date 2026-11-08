// About Time — Web Push plumbing.
//
// iOS only delivers Web Push to a PWA that has been added to the Home Screen
// (16.4+). Everywhere else a normal tab is enough. Permission must be requested
// from a tap, which is why the UI shows an explicit "Turn on alerts" card.

import { VAPID_PUBLIC_KEY } from './config.js';

export function pushSupported() {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function permission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.navigator.standalone === true
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/**
 * Ask for permission, subscribe this device, and hand the subscription to the
 * caller so it can be stored server-side.
 */
export async function enablePush({ onSubscribe }) {
  if (!pushSupported()) throw new Error('push-unsupported');
  if (!VAPID_PUBLIC_KEY) throw new Error('push-not-configured');

  const permissionResult = await Notification.requestPermission();
  if (permissionResult !== 'granted') throw new Error('permission-denied');

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }));

  const json = subscription.toJSON();
  await onSubscribe({
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
  });

  return subscription;
}
