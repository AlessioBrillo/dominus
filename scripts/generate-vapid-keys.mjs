#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Generate a VAPID key pair for Web Push (RFC 8292).
 *
 * Uses only node:crypto — no MPL-licensed CLI dependency. The public key is
 * the uncompressed P-256 point (0x04 || X || Y); the private key is the raw
 * 32-byte scalar. Both are base64url-encoded as the Web Push API expects.
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const uncompressed = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url'),
]);

process.stdout.write(
  `VAPID_PUBLIC_KEY=${uncompressed.toString('base64url')}\n` +
    `VAPID_PRIVATE_KEY=${Buffer.from(priv.d, 'base64url').toString('base64url')}\n`,
);
