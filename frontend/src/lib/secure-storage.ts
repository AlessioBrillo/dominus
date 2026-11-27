// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Optional native secure storage (ADR-0116).
 *
 * The PWA has no Keychain/Keystore, so the fallback is localStorage. A
 * Capacitor build can install a secure-storage plugin later; this adapter
 * detects it at runtime instead of pinning an unverified third-party package
 * into the bundle. A missing or failing plugin is never fatal: the app keeps
 * working with the storage the platform actually provides.
 */
interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

function plugin(): SecureStoragePlugin | undefined {
  const cap = (
    globalThis as {
      Capacitor?: {
        isNative?: boolean;
        Plugins?: Record<string, SecureStoragePlugin>;
      };
    }
  ).Capacitor;
  if (!cap?.isNative) return undefined;
  return cap.Plugins?.['SecureStorage'] ?? cap.Plugins?.['NativeSecureStorage'];
}

export async function readSecure(key: string): Promise<string | null> {
  const native = plugin();
  if (!native) return null;
  try {
    return (await native.get({ key })).value;
  } catch {
    return null;
  }
}

export async function writeSecure(key: string, value: string): Promise<void> {
  const native = plugin();
  if (!native) return;
  try {
    await native.set({ key, value });
  } catch {
    /* the localStorage copy remains the working credential */
  }
}

export async function removeSecure(key: string): Promise<void> {
  const native = plugin();
  if (!native) return;
  try {
    await native.remove({ key });
  } catch {
    /* non-fatal */
  }
}
