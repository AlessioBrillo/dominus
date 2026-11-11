// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Request } from 'express';

/**
 * The identity a per-caller rate-limit bucket is keyed on.
 *
 * The protected router limits every authenticated caller. Two properties
 * matter and both were wrong before:
 *
 * 1. **The bucket key must never be a secret.** The previous key was the
 *    raw `Authorization` header, so the API key itself became the rate
 *    limiter key: it lived in the process heap and, as soon as the store
 *    became shared (Redis, ADR-0033), it landed in the Redis keyspace
 *    where it is readable with `KEYS`, dumped in the AOF and shown by the
 *    monitoring tooling. Only non-secret identifiers are used here.
 *
 * 2. **Every caller needs its own bucket.** The previous key fell back to
 *    the literal `'unknown'` for every browser session (a session cookie
 *    carries no `Authorization` header), so all the SSO users of the
 *    service shared a single counter: one busy tenant could exhaust the
 *    limit for every other tenant. The identity is now derived from the
 *    authenticated principal (the key id for an API key, the subject for
 *    a session), which is unique per caller and known to the middleware
 *    that runs before the limiter.
 *
 * The digest keeps user identifiers (an OIDC subject or an email) out of
 * the keyspace as well: the bucket key is an opaque handle, not a copy of
 * the identity.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Build the rate-limit key for an authenticated request.
 *
 * Resolution order: API key id, then session subject, then tenant, then
 * the (hashed) credential header, then a constant for an unauthenticated
 * caller. The result never contains a credential.
 */
export function buildIdentityRateLimitKey(req: Request): string {
  const auth = req.auth;

  if (auth?.keyId !== undefined) {
    return `key:${auth.keyId}`;
  }
  if (auth?.userId !== undefined && auth.userId !== '') {
    return `user:${digest(auth.userId)}`;
  }
  if (auth?.tenantId !== undefined && auth.tenantId !== '') {
    return `tenant:${digest(auth.tenantId)}`;
  }

  const header = req.headers['authorization'];
  if (typeof header === 'string' && header !== '') {
    return `credential:${digest(header)}`;
  }

  return 'anonymous';
}
