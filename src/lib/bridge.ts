/**
 * Bridge between the KYC page and whatever is hosting it.
 *
 * Three hosts are supported, detected at runtime:
 *
 * - **React Native WebView** — `window.ReactNativeWebView.postMessage`. RN's
 *   `onMessage` receives `event.nativeEvent.data`, which MUST be a string; the
 *   bridge stringifies objects to "[object Object]".
 * - **Iframe** — `window.parent.postMessage`, for a web app embedding the page.
 * - **Popup** — `window.opener.postMessage`, for a web app that opened the page
 *   with `window.open()`.
 *
 * Every event is posted to *all* present targets, so a page that is both framed
 * and script-opened still reaches its host. Messages are JSON strings in all
 * three cases, so one host-side parser handles any embedding.
 */

export type BridgeTransport = 'react-native' | 'iframe' | 'popup' | 'standalone';

export type KycEvent =
  | { type: 'ready'; payload: { sdkVersion: string; transports: BridgeTransport[] } }
  | { type: 'start'; payload: Record<string, never> }
  | { type: 'step'; payload: { step: string } }
  | { type: 'submit'; payload: { verificationId: string; status: string; submittedAt: string; metadata: Record<string, string> } }
  | { type: 'close'; payload: Record<string, never> }
  | { type: 'error'; payload: { code: string; message: string; details?: unknown } };

/** Messages the host can send into the page. */
export type HostCommand = { type: 'close' } | { type: 'ping' };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

/**
 * `targetOrigin` for `postMessage`. `'*'` lets any window that holds a handle to
 * this one read the events (which carry the verificationId), so a real origin is
 * always preferred — see `configureBridge`.
 */
let targetOrigin = '*';
let warnedAboutWildcard = false;

/**
 * Best-effort host origin when none was declared.
 *
 * `document.referrer` is set by the embedder at navigation time, so it survives
 * this page's own `Referrer-Policy: no-referrer` (that policy governs requests
 * we originate, not the referrer we were given). It is still absent when the
 * embedder itself suppresses referrers — hence `hostOrigin` as the reliable path.
 */
function inferHostOrigin(): string | null {
  if (typeof document === 'undefined' || !document.referrer) return null;
  try {
    const origin = new URL(document.referrer).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Pin the origin events are posted to. Call once, before the first event, with
 * the `hostOrigin` from the decoded config.
 */
export function configureBridge(options: { hostOrigin?: string } = {}): string {
  targetOrigin = options.hostOrigin ?? inferHostOrigin() ?? '*';
  return targetOrigin;
}

/** Which hosts are reachable from this page right now. */
export function detectTransports(): BridgeTransport[] {
  if (typeof window === 'undefined') return ['standalone'];

  const transports: BridgeTransport[] = [];
  if (window.ReactNativeWebView) transports.push('react-native');
  if (window.parent && window.parent !== window) transports.push('iframe');
  if (window.opener) transports.push('popup');
  return transports.length ? transports : ['standalone'];
}

/** Post an event to every host that is present. */
export function postToHost(event: KycEvent): void {
  const envelope = { source: 'myaza-kyc', ...event, at: new Date().toISOString() };
  const serialized = JSON.stringify(envelope);

  if (targetOrigin === '*' && !warnedAboutWildcard) {
    warnedAboutWildcard = true;
    console.warn(
      '[kyc-bridge] Posting with targetOrigin "*" — any window holding a handle to this page can read KYC events. Set `hostOrigin` in the config to pin it.',
    );
  }

  let delivered = false;

  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(serialized);
    delivered = true;
  }
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(serialized, targetOrigin);
    delivered = true;
  }
  if (window.opener) {
    // A closed opener throws rather than no-opping.
    try {
      (window.opener as Window).postMessage(serialized, targetOrigin);
      delivered = true;
    } catch {
      /* opener is gone — nothing to deliver to */
    }
  }

  // Standalone (or nothing took it): keep `npm run dev` useful with no host.
  if (!delivered) console.info('[kyc-bridge]', envelope);
}

/**
 * Is this inbound message from somewhere we trust?
 *
 * RN injects via `window.postMessage(...)`, which surfaces with this page's own
 * origin on iOS and as a plain `document` event with no origin on Android — so
 * both of those have to pass.
 */
function isTrustedSource(event: MessageEvent): boolean {
  const origin = event.origin;

  // Android RN: a synthetic `document` event, no origin to check.
  if (!origin) return true;
  // iOS RN and same-origin harnesses.
  if (origin === window.location.origin) return true;

  if (targetOrigin !== '*') return origin === targetOrigin;

  // No pinned origin: at least require it to come from a window that hosts us.
  return event.source === window.parent || event.source === window.opener;
}

/** Subscribe to host commands. Returns an unsubscribe function. */
export function onHostCommand(handler: (command: HostCommand) => void): () => void {
  const listener = (event: MessageEvent | Event) => {
    const message = event as MessageEvent;
    const raw = message.data;
    if (typeof raw !== 'string') return;
    if (!isTrustedSource(message)) return;

    try {
      const parsed = JSON.parse(raw) as HostCommand;
      if (parsed && typeof parsed.type === 'string') handler(parsed);
    } catch {
      // Not our message — other libraries post on this channel too.
    }
  };

  window.addEventListener('message', listener);
  document.addEventListener('message', listener as EventListener);
  return () => {
    window.removeEventListener('message', listener);
    document.removeEventListener('message', listener as EventListener);
  };
}

/**
 * Close the window when the page was opened as a popup.
 *
 * Without this, dismissing the modal in a popup leaves an empty window on
 * screen — the host cannot close it for us across origins. `window.close()` is
 * permitted precisely because the window was script-opened.
 */
export function closeSelfIfPopup(): boolean {
  const isPopup = !!window.opener && window.parent === window;
  if (!isPopup) return false;
  try {
    window.close();
    return true;
  } catch {
    return false;
  }
}
