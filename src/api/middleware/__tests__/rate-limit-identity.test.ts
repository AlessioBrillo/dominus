// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { buildIdentityRateLimitKey } from '../rate-limit-identity.js';

function requestWith(auth: Request['auth'], headers: Record<string, string> = {}): Request {
  return { auth, headers } as unknown as Request;
}

describe('buildIdentityRateLimitKey', () => {
  it('keys an API key caller on its key id', () => {
    const key = buildIdentityRateLimitKey(
      requestWith({ keyId: 42, tenantId: 'tenant-a', role: 'admin' }),
    );
    expect(key).toBe('key:42');
  });

  it('never puts the credential in the key', () => {
    const secret = 'sk-super-secret-value';
    const key = buildIdentityRateLimitKey(
      requestWith({ keyId: 7, tenantId: 'tenant-a' }, { authorization: `Bearer ${secret}` }),
    );
    expect(key).not.toContain(secret);
    expect(key).toBe('key:7');
  });

  it('gives every session user its own bucket', () => {
    const first = buildIdentityRateLimitKey(
      requestWith({ userId: 'auth0|alice', tenantId: 'tenant-a' }),
    );
    const second = buildIdentityRateLimitKey(
      requestWith({ userId: 'auth0|bob', tenantId: 'tenant-a' }),
    );
    expect(first).not.toBe(second);
    expect(first.startsWith('user:')).toBe(true);
    expect(second.startsWith('user:')).toBe(true);
  });

  it('does not leak the user identifier in the key', () => {
    const key = buildIdentityRateLimitKey(
      requestWith({ userId: 'auth0|alice', tenantId: 'tenant-a' }),
    );
    expect(key).not.toContain('alice');
  });

  it('does not collapse every session on one bucket', () => {
    // The regression that made the service unusable for the second tenant:
    // a cookie session carries no Authorization header.
    const first = buildIdentityRateLimitKey(requestWith({ userId: 'auth0|alice' }));
    const second = buildIdentityRateLimitKey(requestWith({ userId: 'auth0|bob' }));
    expect(first).not.toBe(second);
  });

  it('falls back to the tenant when the principal is unknown', () => {
    const key = buildIdentityRateLimitKey(requestWith({ tenantId: 'tenant-a' }));
    expect(key.startsWith('tenant:')).toBe(true);
  });

  it('hashes the credential header when there is no principal', () => {
    const secret = 'sk-super-secret-value';
    const key = buildIdentityRateLimitKey(
      requestWith(undefined, { authorization: `Bearer ${secret}` }),
    );
    expect(key).not.toContain(secret);
    expect(key.startsWith('credential:')).toBe(true);
  });

  it('returns a constant for an unauthenticated caller', () => {
    expect(buildIdentityRateLimitKey(requestWith(undefined))).toBe('anonymous');
  });
});
