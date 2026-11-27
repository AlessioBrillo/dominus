// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin for a bundled Capacitor build. Empty = same origin. */
  readonly VITE_API_BASE_URL?: string;
  /** `store` hides prices and checkout; `web` keeps the full front door. */
  readonly VITE_APP_VARIANT?: 'store' | 'web';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
