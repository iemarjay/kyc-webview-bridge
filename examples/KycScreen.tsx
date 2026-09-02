/**
 * React Native reference screen for the KYC WebView page.
 *
 * Not part of the web build — copy it into your RN app. Requires
 * `react-native-webview`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, PermissionsAndroid, Platform, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

/** Where the built `dist/` is hosted. MUST be https — `getUserMedia` is blocked otherwise. */
const KYC_PAGE_URL = 'https://bob-kyc.pages.dev';

type KycEvent =
  | { source: 'myaza-kyc'; type: 'ready'; payload: { sdkVersion: string } }
  | { source: 'myaza-kyc'; type: 'start'; payload: Record<string, never> }
  | { source: 'myaza-kyc'; type: 'step'; payload: { step: string } }
  | { source: 'myaza-kyc'; type: 'submit'; payload: { verificationId: string; status: string; submittedAt: string; metadata: Record<string, string> } }
  | { source: 'myaza-kyc'; type: 'close'; payload: Record<string, never> }
  | { source: 'myaza-kyc'; type: 'error'; payload: { code: string; message: string; details?: unknown } };

/**
 * base64url-encode a UTF-8 string.
 *
 * RN has no `btoa`/`Buffer` by default, so this walks the UTF-8 bytes directly.
 * If your app already depends on `buffer` or `js-base64`, use that instead.
 */
function base64UrlEncode(input: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes: number[] = [];

  for (const char of input) {
    let code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }

  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const triplet = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const remaining = bytes.length - i;
    out += chars[(triplet >> 18) & 63] + chars[(triplet >> 12) & 63];
    if (remaining > 1) out += chars[(triplet >> 6) & 63];
    if (remaining > 2) out += chars[triplet & 63];
  }
  return out;
}

/** Ask for the camera up front — the page cannot recover from a denial mid-flow. */
async function ensureCameraPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS prompts on first getUserMedia
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
    title: 'Camera access',
    message: 'We need your camera to verify your identity.',
    buttonPositive: 'Allow',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export function KycScreen({ onFinished }: { onFinished: (verificationId?: string) => void }) {
  const webviewRef = useRef<WebView>(null);
  const [permitted, setPermitted] = useState<boolean | null>(null);

  useEffect(() => {
    void ensureCameraPermission().then(setPermitted);
  }, []);

  // Required: `apiKey`, `userId`, and one of `workflowId` / `country`. The
  // `userId` is what ties the webhook result back to your user record, so pass
  // the signed-in user's id rather than a placeholder. `userData` (prefill) and
  // `metadata` (request tagging) are optional.
  const uri = `${KYC_PAGE_URL}/#${base64UrlEncode(
    JSON.stringify({
      apiKey: 'pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      workflowId: 'wf_AbC123dEf456',
      userId: 'user_42',
    }),
  )}`;

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: KycEvent;
      try {
        message = JSON.parse(event.nativeEvent.data) as KycEvent;
      } catch {
        return; // not ours
      }
      if (message?.source !== 'myaza-kyc') return;

      switch (message.type) {
        case 'ready':
        case 'start':
          break;
        case 'step':
          // Useful for analytics or a native progress indicator.
          console.log('kyc step:', message.payload.step);
          break;
        case 'submit':
          // Accepted for review — NOT an approval. The outcome arrives on your
          // backend webhook; correlate with this id.
          onFinished(message.payload.verificationId);
          break;
        case 'close':
          onFinished();
          break;
        case 'error':
          Alert.alert('Verification unavailable', message.payload.message);
          if (message.payload.code === 'invalid_api_key' || message.payload.code.startsWith('payload_')) {
            onFinished();
          }
          break;
      }
    },
    [onFinished],
  );

  /** Close the flow from native — e.g. the Android hardware back button. */
  const requestClose = useCallback(() => {
    const command = JSON.stringify(JSON.stringify({ type: 'close' }));
    webviewRef.current?.injectJavaScript(`window.postMessage(${command}, '*'); true;`);
  }, []);
  void requestClose; // wire to your back handler

  if (permitted === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <WebView
      ref={webviewRef}
      source={{ uri }}
      onMessage={handleMessage}
      style={styles.webview}
      originWhitelist={['https://*']}
      javaScriptEnabled
      domStorageEnabled
      // Camera: inline playback is required on iOS or the video element goes
      // fullscreen and breaks the liveness framing.
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      // Keep the flow inside the WebView; the SDK opens no external links.
      setSupportMultipleWindows={false}
      onRenderProcessGone={() => onFinished()}
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: 'transparent' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
