// SPDX-License-Identifier: AGPL-3.0-only
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The store shell bundles the exact same built assets as the PWA (ADR-0114).
 * No remote URL is loaded: the webview serves local files and calls the API
 * at the absolute origin injected by `npm run mobile:build`.
 */
const config: CapacitorConfig = {
  appId: 'app.dominus.mobile',
  appName: 'DOMINUS',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // The API origin is a build-time env var, never a runtime redirect:
    // a store app that merely frames a website fails App Store 4.2.
  },
  ios: {
    contentInset: 'always',
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#0b0f14',
      showSpinner: false,
    },
  },
};

export default config;
