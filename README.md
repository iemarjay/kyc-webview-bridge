# kyc-webview-bridge

A static React page that runs [`@myazahq/kyc-sdk-react`](https://www.npmjs.com/package/@myazahq/kyc-sdk-react)
inside a React Native `WebView`. The native app passes runtime config as
base64-encoded JSON in the URL fragment; the page reports every lifecycle event
back through `postMessage`.

Unofficial — not affiliated with Myaza.

- **Vite + React**, no server. The build is plain static files — host it on any
  CDN, or ship it inside the app bundle.
- Opens the flow **on mount** (`defaultOpen`), so there is no trigger button to
  tap. The native app already decided the user is verifying.

## URL contract

Config is base64-encoded JSON, passed in the **fragment**:

```
https://kyc.example.com/#<base64url(JSON.stringify(config))>
```

The fragment is used rather than a query string because fragments are never
sent to the server — the applicant's name and user id stay out of access logs,
proxies and the `Referer` header. `?data=<base64>` and `#data=<base64>` are
accepted as fallbacks. Both standard base64 and base64url decode, padded or not.

The JSON is `MyazaKYCConfig` minus the callbacks (which are wired to the bridge
on the web side). **Required: `apiKey`, `userId`, and either `workflowId` or
`country`.**

```json
{
  "apiKey": "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "workflowId": "wf_AbC123dEf456",
  "userId": "user_42"
}
```

`userId` is your own reference for the person. It becomes `Entity.externalUserId`,
so repeat checks collapse onto one entity and the webhook result can be tied back
to your record. It is **not** matched during verification.

The SDK itself treats `userId` as optional — this page requires it deliberately.
The verification outcome arrives asynchronously on a backend webhook, and without
a `userId` the server falls back to its own provider record id, leaving you
nothing to correlate against. A missing one is rejected up front as
`payload_invalid` rather than stranding a result later.

The rest is optional and only worth sending when you have it:

| Field       | Why you'd send it |
| ----------- | ----------------- |
| `userData`  | Prefill — `firstName`, `lastName`, `dateOfBirth`. Fields provided here aren't collected again. Omit it and the applicant simply types them in. |
| `metadata`  | `Record<string, string>` forwarded with every verify request and echoed back on `submit`. Handy for tying a verification to an order or request id. |

### Building the URL in Node.js

Minting the link on your backend is the usual pattern — it keeps the `userId`
authoritative (taken from the session, not the client) and lets you swap the
API key per environment without shipping an app update.

Node's `base64url` encoding is exactly what the page expects: URL-safe alphabet,
padding stripped, no escaping needed.

```js
// Node 16+ — no dependencies.
function buildKycUrl({ baseUrl, apiKey, workflowId, userId, userData, metadata }) {
  const config = { apiKey, workflowId, userId };
  if (userData) config.userData = userData; // optional prefill
  if (metadata) config.metadata = metadata; // optional request tagging

  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
  return `${baseUrl}/#${encoded}`;
}

// e.g. in an Express handler, where `req.user` is the *authenticated* user
app.post('/kyc/session', (req, res) => {
  const url = buildKycUrl({
    baseUrl: 'https://kyc.example.com',
    apiKey: process.env.MYAZA_PUBLIC_KEY, // pk_test_… / pk_live_…
    workflowId: process.env.MYAZA_WORKFLOW_ID,
    userId: req.user.id,
    userData: { firstName: req.user.firstName, lastName: req.user.lastName },
    metadata: { requestId: req.id },
  });
  res.json({ url }); // the app puts this straight into the WebView `source.uri`
});
```

Decoding one again — handy when debugging a link from a log or a bug report:

```js
const encoded = new URL(url).hash.slice(1);
const config = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
```

Two things worth keeping straight:

- The `pk_` key is **publishable** — it is designed to be visible to the client,
  the same way a Stripe `pk_` key is. Never put a secret key in this payload; it
  would end up in the URL, the WebView, and every log line that captures it.
- Take `userId` from the server-side session, not from the client. If the app
  supplies it, a user can rewrite the fragment and file a verification against
  someone else's id.

Anything else the SDK accepts — `appearance`, `disableClose`,
`requireMobileDevice`, `consent`, `success` — passes straight through. The key
prefix picks the environment (`pk_test_` → sandbox, `pk_live_` → production);
there is no environment flag.

A malformed or missing payload is reported as an `error` event and renders
nothing, leaving the native app to own the failure UI.

## Events sent to native

Every message is a JSON **string** (RN's bridge stringifies objects to
`"[object Object]"`, so the page serializes them itself). All carry
`source: "myaza-kyc"` and an ISO `at` timestamp — filter on `source`, since
other libraries post on the same channel.

| `type`   | `payload`                                            | When |
| -------- | ---------------------------------------------------- | ---- |
| `ready`  | `{ sdkVersion }`                                     | Page mounted and config decoded. Fires once. |
| `start`  | `{}`                                                 | Flow opened. |
| `step`   | `{ step }`                                           | Each step transition (`consent`, `liveness`, `submitted`, …). |
| `submit` | `{ verificationId, status, submittedAt, metadata }`  | Server accepted the submission. `status` is always `"pending"`. |
| `close`  | `{}`                                                 | User dismissed the flow. |
| `error`  | `{ code, message, details? }`                        | Technical errors only — see codes below. |

`error.code` is the SDK's typed `KYCErrorCode`: `network_error`,
`invalid_api_key`, `insufficient_credits`, `upload_failed`,
`camera_permission_denied`, `feature_disabled`, `invalid_workflow`, `unknown`
— plus `payload_missing` / `payload_malformed` / `payload_invalid` from this
page's own decoding.

**A verification outcome never arrives here.** `submit` means "accepted for
review". Approval/rejection lands on your backend webhook — treat
`verificationId` as the correlation key, never a pass.

## Commands from native

Inject a JSON string to drive the page — used for the Android hardware back
button or a session timeout:

```js
webviewRef.current.injectJavaScript(
  `window.postMessage(${JSON.stringify(JSON.stringify({ type: 'close' }))}, '*'); true;`,
);
```

The page listens on both `window` and `document` because the two platforms
deliver these differently.

## React Native side

See [`examples/KycScreen.tsx`](examples/KycScreen.tsx) for a complete screen.
The parts that matter:

```tsx
const encoded = base64UrlEncode(JSON.stringify(config));

<WebView
  source={{ uri: `https://kyc.example.com/#${encoded}` }}
  onMessage={handleMessage}
  // Required for the liveness camera:
  allowsInlineMediaPlayback           // iOS: without it, video goes fullscreen
  mediaPlaybackRequiresUserAction={false}
  javaScriptEnabled
  domStorageEnabled                   // Android: the SDK uses localStorage
/>
```

### Camera permissions

The liveness and document-capture steps call `getUserMedia`, which needs three
things lined up:

1. **A secure context.** `getUserMedia` is blocked on plain `http://` — the page
   must be served over **HTTPS** (or `localhost`). This is the single most
   common cause of a WebView that works in a browser but not on device.
2. **Native permission**, requested *before* the WebView loads:
   - iOS — `NSCameraUsageDescription` in `Info.plist`.
   - Android — `<uses-permission android:name="android.permission.CAMERA" />`
     in the manifest, plus a runtime `PermissionsAndroid.request`.
     `react-native-webview` then auto-grants the page's request.
3. On Android, `react-native-webview` handles `onPermissionRequest` only when
   the app itself already holds the permission — so request it first, or the
   page gets a silent denial surfaced as `camera_permission_denied`.

## Development

```bash
npm run dev
```

Then open <http://localhost:5173/harness.html> — a harness that encodes a config,
loads the page in an iframe, and logs the outgoing messages. Outside a WebView
the bridge falls back to `parent.postMessage` and `console.info`, so the same
build is testable without a device.

To test on a physical phone, the dev server binds to the LAN
(`http://<your-ip>:5173`). Note that camera steps still need HTTPS — use a
tunnel (`ngrok`, `cloudflared`) rather than the raw LAN address.

```bash
npm run build     # → dist/, deployable anywhere static
npm run preview   # serve the production build locally
```

## Deployment

Live on Cloudflare Pages: **<https://bob-kyc.pages.dev>**

```bash
npm run deploy
```

That builds and pushes `dist/` to the `bob-kyc` Pages project. Cloudflare serves
it over HTTPS, which is the hard requirement for the camera steps.

Two Pages behaviours worth knowing:

- **`.html` is stripped.** `/harness.html` 308-redirects to `/harness`. The
  entry point `/` is unaffected, so the WebView URL is just
  `https://bob-kyc.pages.dev/#<base64>`.
- **`public/_headers`** ships `nosniff`, `Referrer-Policy: no-referrer` (belt
  and braces with the fragment-based config) and `X-Frame-Options: SAMEORIGIN`.
  A WebView loads the page top-level, so framing rules don't affect it.

The dev harness is deployed too, at
[`/harness`](https://bob-kyc.pages.dev/harness) — useful precisely because it
runs on a real HTTPS origin, which is the only place the camera steps work. It
adds no attack surface (the fragment contract is public either way), but delete
`public/harness.html` before a production launch if you'd rather it weren't
there.

## Layout

| Path                  | Purpose |
| --------------------- | ------- |
| `src/lib/payload.ts`  | Base64 → validated config, with UTF-8-safe decoding. |
| `src/lib/bridge.ts`   | `postMessage` transport and the event/command types. |
| `src/App.tsx`         | Decodes, mounts the SDK, maps callbacks onto the bridge. |
| `public/harness.html` | Browser dev harness. |
| `examples/`           | React Native reference screen. |
