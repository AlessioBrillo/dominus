// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jwtVerify = vi.hoisted(() => vi.fn());
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify,
}));

import { Auth0Provider } from '../auth0-provider.js';

const provider = new Auth0Provider({ domain: 'idp.example.com', audience: 'api' });

const verified = (payload: Record<string, unknown>): void => {
  jwtVerify.mockResolvedValueOnce({ payload });
};

beforeEach(() => jwtVerify.mockReset());

describe('Auth0Provider.validate — email', () => {
  it('exposes the email, lower-cased, only when the IdP marked it verified', async () => {
    verified({ sub: 'auth0|1', email: 'Bob@Example.com', email_verified: true });
    const result = await provider.validate('t');
    expect(result.authenticated).toBe(true);
    expect(result.email).toBe('bob@example.com');
  });

  it('ignores an unverified email: it proves nothing about who owns the address', async () => {
    verified({ sub: 'auth0|1', email: 'bob@example.com', email_verified: false });
    expect((await provider.validate('t')).email).toBeUndefined();

    verified({ sub: 'auth0|1', email: 'bob@example.com' });
    expect((await provider.validate('t')).email).toBeUndefined();
  });

  it('carries tenant and role claims as before', async () => {
    verified({ sub: 'auth0|1', org_id: 'org-9', role: 'member' });
    const r = await provider.validate('t');
    expect(r).toMatchObject({ userId: 'auth0|1', tenantId: 'org-9', role: 'member' });
  });

  it('rejects a token that fails verification', async () => {
    jwtVerify.mockRejectedValueOnce(new Error('bad signature'));
    expect(await provider.validate('t')).toEqual({ authenticated: false });
  });
});
