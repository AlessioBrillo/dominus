// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Auth0OidcProvider } from '../oidc-provider.js';
import type { AuthProvider } from '../auth-provider.js';

const validator: AuthProvider = {
  name: 'Auth0Provider',
  isActive: true,
  supportsKeyManagement: false,
  validate: vi.fn().mockResolvedValue({ authenticated: true, userId: 'user-1' }),
  asKeyManager: () => undefined,
};

function makeProvider(
  overrides: Partial<ConstructorParameters<typeof Auth0OidcProvider>[0]> = {},
): Auth0OidcProvider {
  return new Auth0OidcProvider({
    domain: 'dominus.eu.auth0.com',
    clientId: 'client-123',
    clientSecret: 'secret-456',
    callbackUrl: 'https://dominus.app/api/v1/auth/oidc/callback',
    tokenValidator: validator,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Auth0OidcProvider.buildAuthorizeUrl', () => {
  it('builds an authorization-code + PKCE S256 URL', () => {
    const url = new URL(
      makeProvider().buildAuthorizeUrl({
        state: 'st-1',
        codeChallenge: 'ch-1',
        redirectUri: 'https://dominus.app/api/v1/auth/oidc/callback',
      }),
    );
    expect(url.origin).toBe('https://dominus.eu.auth0.com');
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://dominus.app/api/v1/auth/oidc/callback',
    );
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('code_challenge')).toBe('ch-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('openid');
  });
});

describe('Auth0OidcProvider.exchangeCode', () => {
  it('exchanges the code for tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: 'at-1',
          id_token: 'id-1',
          expires_in: 3600,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeProvider().exchangeCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'https://dominus.app/api/v1/auth/oidc/callback',
    });

    expect(result).toEqual({ accessToken: 'at-1', idToken: 'id-1', expiresIn: 3600 });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(url).toBe('https://dominus.eu.auth0.com/oauth/token');
    expect(String(init.body)).toContain('grant_type=authorization_code');
    expect(String(init.body)).toContain('code_verifier=verifier-1');
    expect(String(init.body)).toContain('client_secret=secret-456');
  });

  it('throws on IdP HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({}) }),
    );
    await expect(
      makeProvider().exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }),
    ).rejects.toThrow('status 400');
  });

  it('throws when the IdP reports an error payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ error: 'invalid_grant' }),
      }),
    );
    await expect(
      makeProvider().exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }),
    ).rejects.toThrow('invalid_grant');
  });
});

describe('Auth0OidcProvider.validateIdToken', () => {
  it('delegates to the token validator', async () => {
    const result = await makeProvider().validateIdToken('id-token');
    expect(result).toEqual({ authenticated: true, userId: 'user-1' });
    expect(validator.validate).toHaveBeenCalledWith('id-token');
  });
});

describe('Auth0OidcProvider.logoutUrl', () => {
  it('points at the Auth0 logout endpoint with client_id + returnTo', () => {
    const url = new URL(makeProvider().logoutUrl('https://dominus.app/'));
    expect(url.pathname).toBe('/v2/logout');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('returnTo')).toBe('https://dominus.app/');
  });
});
