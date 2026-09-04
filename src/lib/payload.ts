import type { MyazaKYCConfig } from '@myazahq/kyc-sdk-react';

/**
 * The runtime config the native app hands us, base64-encoded in the URL.
 *
 * Only the data half of `MyazaKYCConfig` — the callbacks are wired to the
 * native bridge on this side and can't cross a URL.
 */
export type KycPayload = Omit<
  MyazaKYCConfig,
  'onStart' | 'onStepChange' | 'onSubmit' | 'onClose' | 'onError'
> & {
  /**
   * Required by this integration, though the SDK itself treats it as optional.
   *
   * It is the only handle tying a verification back to your user record: the
   * result arrives asynchronously on a backend webhook, and without a `userId`
   * the server falls back to its own provider record id, leaving nothing to
   * correlate against. Cheaper to reject here than to strand a result later.
   */
  userId: string;

  /**
   * Origin of the embedding web app, used as `postMessage`'s `targetOrigin`.
   *
   * Web embeds only — a React Native WebView ignores it. Without it the page
   * infers the origin from `document.referrer` and otherwise falls back to
   * `'*'`, which lets any window holding a handle to this page read the KYC
   * events. Set it whenever you embed in a browser.
   */
  hostOrigin?: string;
};

export type PayloadErrorCode = 'missing' | 'malformed' | 'invalid';

export class PayloadError extends Error {
  readonly code: PayloadErrorCode;

  constructor(message: string, code: PayloadErrorCode) {
    super(message);
    this.name = 'PayloadError';
    this.code = code;
  }
}

/**
 * Decode standard base64 *or* base64url into a UTF-8 string.
 *
 * `atob` yields one byte per char, so anything non-ASCII (a name like "José")
 * comes back mojibake unless we re-decode those bytes as UTF-8 — hence the
 * TextDecoder pass rather than the shorter `atob` one-liner.
 */
function decodeBase64Utf8(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Pull the encoded payload out of the URL.
 *
 * The hash is preferred and checked first: fragments are never sent to the
 * server, so the applicant's PII stays out of access logs, proxies and the
 * Referer header. `?data=` is supported as a fallback for hosts that rewrite
 * fragments away.
 */
function readEncodedFromUrl(url: string): string | null {
  const parsed = new URL(url);

  const hash = parsed.hash.slice(1);
  if (hash) {
    // Accept both `#<base64>` and `#data=<base64>`.
    const fromHashParam = new URLSearchParams(hash).get('data');
    return fromHashParam ?? hash;
  }

  return parsed.searchParams.get('data');
}

/** Parse and validate the base64 config, throwing a typed `PayloadError`. */
export function decodePayload(url: string = window.location.href): KycPayload {
  const encoded = readEncodedFromUrl(url);
  if (!encoded) {
    throw new PayloadError('No config found in the URL (expected `#<base64>` or `?data=<base64>`).', 'missing');
  }

  let json: string;
  try {
    json = decodeBase64Utf8(encoded);
  } catch {
    throw new PayloadError('The config could not be base64-decoded as UTF-8.', 'malformed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PayloadError('The decoded config is not valid JSON.', 'malformed');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PayloadError('The decoded config must be a JSON object.', 'invalid');
  }

  const payload = parsed as KycPayload;

  if (typeof payload.apiKey !== 'string' || !payload.apiKey) {
    throw new PayloadError('`apiKey` is required in the config.', 'invalid');
  }

  if (typeof payload.userId !== 'string' || !payload.userId.trim()) {
    throw new PayloadError('`userId` is required so the verification can be tied back to your user record.', 'invalid');
  }

  if (payload.hostOrigin !== undefined) {
    // A malformed origin would silently become a `postMessage` no-op, so the
    // events would just vanish. Better to say so up front.
    let parsed: URL;
    try {
      parsed = new URL(payload.hostOrigin);
    } catch {
      throw new PayloadError('`hostOrigin` must be an absolute origin, e.g. "https://app.example.com".', 'invalid');
    }
    if (parsed.origin !== payload.hostOrigin) {
      throw new PayloadError(
        `\`hostOrigin\` must be a bare origin with no path or trailing slash — did you mean "${parsed.origin}"?`,
        'invalid',
      );
    }
  }

  // The SDK throws on this combination during render; catching it here turns a
  // blank screen into a typed error the native side can act on.
  const businessCountry = payload.subjectType === 'business' ? payload.business?.country : undefined;
  if (!payload.workflowId && !payload.country && !businessCountry) {
    throw new PayloadError('Provide `workflowId`, or `country` for a hand-configured flow.', 'invalid');
  }

  return payload;
}

/** Encode a config for the URL — used by the dev harness and handy in tests. */
export function encodePayload(payload: KycPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
