/**
 * Web Push, page side (the worker's side is the push and notificationclick
 * handlers in views/assets/src-sw.ts). Hand-written JS because the Push API
 * is imperative: permission, PushManager, the VAPID key as bytes. Imported
 * by pwa.js on signed-in pages (the layout marks them `data-signed-in` on
 * <html>: the session cookie is httpOnly, so the server's word is the only
 * way to know).
 *
 *  - syncSubscription(): once per document, sends this browser's existing
 *    subscription to the server, which upserts it by endpoint. That keeps
 *    the row's keys current and moves it to whoever is signed in here now.
 *  - <push-settings> (the profile page, src/web/push/settings.tsx): shows
 *    this browser's state and turns notifications on or off. The permission
 *    prompt only comes from a tap on its enable button: browsers penalize
 *    prompts without a gesture, and iOS refuses them.
 */

const SUBSCRIBE_URL = '/push/subscribe';
const UNSUBSCRIBE_URL = '/push/unsubscribe';
const PUBLIC_KEY_URL = '/push/vapid-public-key';

function pushSupported() {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
}

async function fetchPublicKey() {
  const response = await fetch(PUBLIC_KEY_URL);
  if (!response.ok) {
    throw new Error(`${PUBLIC_KEY_URL} answered ${response.status}`);
  }
  return base64UrlToBytes((await response.text()).trim());
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** @type {Promise<PushSubscription | null> | undefined} */
let synced;

/**
 * This browser's subscription once the server has it, or null when there is
 * none (or permission is not granted). Runs once per document; a failure is
 * not remembered, so the next caller tries again.
 */
export function syncSubscription() {
  synced ??= (async () => {
    if (!pushSupported() || Notification.permission !== 'granted') return null;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await postJson(SUBSCRIBE_URL, subscription.toJSON());
      console.info('[push] subscription confirmed with the server');
    }
    return subscription;
  })().catch((error) => {
    synced = undefined;
    throw error;
  });
  return synced;
}

class PushSettingsElement extends HTMLElement {
  /** Prepared before any tap, so enabling awaits nothing before subscribe(). */
  #registration = null;
  #publicKey = null;

  connectedCallback() {
    this.addEventListener('click', this);
    void this.#refresh();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this);
  }

  handleEvent(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    if (button.dataset.action === 'enable')
      void this.#run(() => this.#enable());
    if (button.dataset.action === 'disable')
      void this.#run(() => this.#disable());
  }

  #show(state) {
    this.dataset.state = state;
    for (const element of this.querySelectorAll('[data-show]')) {
      element.hidden = !element.dataset.show.split(' ').includes(state);
    }
  }

  async #refresh() {
    try {
      this.#show(await this.#currentState());
    } catch (error) {
      console.warn('[push] could not read this device state', error);
      this.#show('error');
    }
  }

  async #currentState() {
    if (!pushSupported()) {
      // iOS and iPadOS have push only in the Home Screen app;
      // navigator.standalone exists only there, false in a Safari tab.
      return navigator.standalone === false ? 'install' : 'unsupported';
    }
    if (Notification.permission === 'denied') return 'blocked';
    if (await syncSubscription()) return 'on';
    await this.#prepare();
    return 'off';
  }

  async #prepare() {
    this.#registration ??= await navigator.serviceWorker.ready;
    this.#publicKey ??= await fetchPublicKey();
  }

  // Buttons stay disabled while a change is in flight; the outcome decides
  // the state shown.
  async #run(change) {
    const buttons = this.querySelectorAll('button');
    for (const button of buttons) button.disabled = true;
    try {
      this.#show(await change());
    } catch (error) {
      console.warn('[push] change failed', error);
      this.#show(this.#stateAfterFailure());
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  }

  #stateAfterFailure() {
    // A refused or dismissed prompt is the user's answer, not an error.
    if (Notification.permission === 'denied') return 'blocked';
    if (Notification.permission === 'default') return 'off';
    return 'error';
  }

  async #enable() {
    // subscribe() asks for permission itself. It must be the first thing
    // awaited after the tap (iOS drops the gesture across other awaits), so
    // the registration and key come from #prepare() when they can.
    if (!this.#registration || !this.#publicKey) await this.#prepare();
    const subscription = await this.#registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.#publicKey,
    });
    await postJson(SUBSCRIBE_URL, subscription.toJSON());
    synced = Promise.resolve(subscription);
    console.info('[push] enabled on this device');
    return 'on';
  }

  async #disable() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      // Server first: if that fails nothing has changed, and the browser's
      // subscription is still there to try again with.
      await postJson(UNSUBSCRIBE_URL, { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    synced = Promise.resolve(null);
    console.info('[push] disabled on this device');
    return 'off';
  }
}

// Modules run once per document; the element upgrades wherever a boosted
// navigation later swaps <push-settings> in.
customElements.define('push-settings', PushSettingsElement);
