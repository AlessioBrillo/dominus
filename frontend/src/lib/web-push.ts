// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VAPID application server keys are transmitted as base64url strings;
 * PushManager.subscribe expects the raw bytes as an ArrayBuffer (ADR-0116).
 * One conversion shared by the onboarding opt-in and the Account screen keeps
 * the two entry points from drifting apart.
 */
export function toApplicationServerKey(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}
