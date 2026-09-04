import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MyazaKYC, type KYCError, type KYCStep, type KYCSubmission } from '@myazahq/kyc-sdk-react';
import '@myazahq/kyc-sdk-react/styles.css';

import { closeSelfIfPopup, configureBridge, detectTransports, onHostCommand, postToHost } from './lib/bridge';
import { decodePayload, PayloadError, type KycPayload } from './lib/payload';

type DecodeState =
  | { status: 'ok'; payload: KycPayload }
  | { status: 'failed'; code: string; message: string };

function decodeOnce(): DecodeState {
  try {
    return { status: 'ok', payload: decodePayload() };
  } catch (error) {
    const isPayloadError = error instanceof PayloadError;
    return {
      status: 'failed',
      code: isPayloadError ? `payload_${error.code}` : 'payload_unknown',
      message: error instanceof Error ? error.message : 'Unknown error reading the config.',
    };
  }
}

export default function App() {
  // Decoded once via lazy state: the URL cannot change under a mounted WebView,
  // and re-decoding on every render would remount the SDK mid-flow.
  const [decoded] = useState<DecodeState>(decodeOnce);
  const [dismissed, setDismissed] = useState(false);

  // StrictMode runs effects twice in development; the native side counts a
  // `ready` as "the WebView is live", so it must fire exactly once per mount.
  const announcedRef = useRef(false);
  useEffect(() => {
    if (announcedRef.current) return;
    announcedRef.current = true;

    // Pin the postMessage target before anything is sent. A failed decode has
    // no `hostOrigin` to offer, so that path falls back to inference — its
    // payload is a code and a message, never verification data.
    configureBridge({ hostOrigin: decoded.status === 'ok' ? decoded.payload.hostOrigin : undefined });

    if (decoded.status === 'failed') {
      postToHost({ type: 'error', payload: { code: decoded.code, message: decoded.message } });
      return;
    }
    postToHost({ type: 'ready', payload: { sdkVersion: __SDK_VERSION__, transports: detectTransports() } });
  }, [decoded]);

  // Let the native side tear the flow down (hardware back button, app
  // backgrounding, a timeout) without unmounting the WebView.
  useEffect(
    () =>
      onHostCommand((command) => {
        if (command.type === 'close') setDismissed(true);
      }),
    [],
  );

  const handleStart = useCallback(() => {
    postToHost({ type: 'start', payload: {} });
  }, []);

  const handleStepChange = useCallback((step: KYCStep) => {
    postToHost({ type: 'step', payload: { step } });
  }, []);

  const handleSubmit = useCallback((submission: KYCSubmission) => {
    postToHost({
      type: 'submit',
      payload: {
        verificationId: submission.verificationId,
        status: submission.status,
        submittedAt: submission.submittedAt,
        metadata: submission.metadata,
      },
    });
  }, []);

  const handleClose = useCallback(() => {
    setDismissed(true);
    postToHost({ type: 'close', payload: {} });
    // In a popup the host cannot close us across origins, so an unclosed window
    // would just sit there empty. No-ops for WebView and iframe embeds.
    closeSelfIfPopup();
  }, []);

  const handleError = useCallback((error: KYCError) => {
    postToHost({
      type: 'error',
      payload: { code: error.code, message: error.message, details: error.details },
    });
  }, []);

  // `payload` is spread last-to-first: the native config wins over nothing, but
  // the callbacks below it can never be clobbered by a stray key in the JSON.
  const config = useMemo(() => (decoded.status === 'ok' ? decoded.payload : null), [decoded]);

  if (!config) {
    // Errors are reported over the bridge, not rendered — native owns the UI
    // for failure. This keeps the WebView transparent instead of flashing an
    // unstyled message behind the host's own error screen.
    return null;
  }

  if (dismissed) return null;

  return (
    <MyazaKYC
      {...config}
      // Open on mount and suppress the trigger button: in a WebView the host
      // app already decided the user is verifying, so a second tap is friction.
      defaultOpen
      onStart={handleStart}
      onStepChange={handleStepChange}
      onSubmit={handleSubmit}
      onClose={handleClose}
      onError={handleError}
    />
  );
}
