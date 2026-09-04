/**
 * Embedding the KYC page in a web app — iframe or popup.
 *
 * Both transports speak the same protocol as the React Native WebView: the page
 * posts JSON strings, so one parser handles every embedding.
 */

const KYC_PAGE_URL = 'https://kyc-webview-bridge.pages.dev';

/** base64url-encode a UTF-8 string (browser equivalent of Buffer's base64url). */
function base64UrlEncode(input) {
  const bytes = new TextEncoder().encode(input);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the URL. `hostOrigin` is what pins `postMessage`'s targetOrigin, so the
 * events cannot be read by another window that happens to hold a handle to the
 * page — always send it from a web app.
 */
function buildUrl(config) {
  return `${KYC_PAGE_URL}/#${base64UrlEncode(JSON.stringify({ hostOrigin: window.location.origin, ...config }))}`;
}

/**
 * Listen for events from the KYC page.
 *
 * The origin check is the important line: without it, any page could post a
 * fake `submit` and convince your app a user is verified.
 */
function listen({ expectedSource, onEvent }) {
  const handler = (event) => {
    if (event.origin !== new URL(KYC_PAGE_URL).origin) return;
    if (expectedSource && event.source !== expectedSource) return;
    if (typeof event.data !== 'string') return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.source !== 'myaza-kyc') return;
    onEvent(message);
  };

  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/** Embed in an iframe. Returns a teardown function. */
export function mountKycIframe({ container, config, onEvent }) {
  const iframe = document.createElement('iframe');
  iframe.src = buildUrl(config);
  iframe.allow = 'camera; microphone; accelerometer; gyroscope';
  iframe.style.cssText = 'border:0;width:100%;height:100%';
  container.appendChild(iframe);

  const stop = listen({ expectedSource: iframe.contentWindow, onEvent });

  return () => {
    stop();
    iframe.remove();
  };
}

/**
 * Open in a popup. Must be called from a user gesture (a click handler) or the
 * browser blocks it.
 */
export function openKycPopup({ config, onEvent }) {
  const popup = window.open(buildUrl(config), 'kyc', 'width=420,height=760');
  if (!popup) throw new Error('Popup blocked — call this from a click handler.');

  const stop = listen({ expectedSource: popup, onEvent });

  // The page closes itself on dismissal, so watch for that to stop listening.
  const poll = setInterval(() => {
    if (popup.closed) {
      clearInterval(poll);
      stop();
    }
  }, 500);

  return () => {
    clearInterval(poll);
    stop();
    if (!popup.closed) popup.close();
  };
}

/* ------------------------------------------------------------------ usage */
//
// const teardown = mountKycIframe({
//   container: document.getElementById('kyc'),
//   config: {
//     apiKey: 'pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
//     workflowId: 'wf_AbC123dEf456',
//     userId: 'user_42',
//   },
//   onEvent: (message) => {
//     switch (message.type) {
//       case 'submit':
//         // Accepted for review — NOT an approval. Confirm on your backend
//         // webhook before granting access.
//         console.log('verificationId', message.payload.verificationId);
//         break;
//       case 'close':
//         teardown();
//         break;
//       case 'error':
//         console.error(message.payload.code, message.payload.message);
//         break;
//     }
//   },
// });
//
// To close the flow from the host (iframe transport):
//   iframe.contentWindow.postMessage(JSON.stringify({ type: 'close' }), KYC_ORIGIN);
