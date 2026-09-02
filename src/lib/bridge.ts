/**
 * Bridge between the KYC web page and the React Native WebView that hosts it.
 *
 * Outbound: every event is a JSON string posted through
 * `window.ReactNativeWebView.postMessage`. RN's `onMessage` receives it as
 * `event.nativeEvent.data`, so it MUST be a string — objects get stringified
 * to "[object Object]" by the bridge.
 *
 * Inbound: RN calls `webviewRef.current.injectJavaScript(...)` to dispatch a
 * message onto `document`/`window`. We listen for both because the platforms
 * differ: on Android `postMessage` from RN lands on `document`, on iOS on
 * `window`.
 */

export type KycEvent =
  | { type: 'ready'; payload: { sdkVersion: string } }
  | { type: 'start'; payload: Record<string, never> }
  | { type: 'step'; payload: { step: string } }
  | { type: 'submit'; payload: { verificationId: string; status: string; submittedAt: string; metadata: Record<string, string> } }
  | { type: 'close'; payload: Record<string, never> }
  | { type: 'error'; payload: { code: string; message: string; details?: unknown } };

/** Messages the native side can send into the page. */
export type HostCommand = { type: 'close' } | { type: 'ping' };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

const isInWebView = (): boolean => typeof window !== 'undefined' && !!window.ReactNativeWebView;

/**
 * Send an event to the native host.
 *
 * Outside a WebView (plain browser, local dev) we fall back to `parent.postMessage`
 * so the same page can be exercised in an iframe harness, and always log — that
 * keeps `npm run dev` useful without a device attached.
 */
export function postToNative(event: KycEvent): void {
  const envelope = { source: 'myaza-kyc', ...event, at: new Date().toISOString() };
  const serialized = JSON.stringify(envelope);

  if (isInWebView()) {
    window.ReactNativeWebView!.postMessage(serialized);
    return;
  }

  // Dev / iframe fallback. `*` is safe here: the envelope carries no secrets,
  // only verification ids and lifecycle state.
  if (typeof window !== 'undefined' && window.parent !== window) {
    window.parent.postMessage(serialized, '*');
  }
  console.info('[kyc-bridge]', envelope);
}

/**
 * Subscribe to commands from the native host. Returns an unsubscribe function.
 */
export function onHostCommand(handler: (command: HostCommand) => void): () => void {
  const listener = (event: MessageEvent | Event) => {
    const raw = (event as MessageEvent).data;
    if (typeof raw !== 'string') return;
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
