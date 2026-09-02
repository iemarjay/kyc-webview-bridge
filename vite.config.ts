import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Read straight off disk: the SDK's `exports` map does not expose
// ./package.json, so `require('@myazahq/kyc-sdk-react/package.json')` throws.
const { version: sdkVersion } = JSON.parse(
  readFileSync(new URL('./node_modules/@myazahq/kyc-sdk-react/package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __SDK_VERSION__: JSON.stringify(sdkVersion),
  },
  // Relative asset URLs so the build can be served from any sub-path — or from
  // the device filesystem if you bundle it into the app instead of hosting it.
  base: './',
  server: {
    host: true, // reachable from a phone/emulator on the LAN during development
  },
});
