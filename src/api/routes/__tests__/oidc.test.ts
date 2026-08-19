// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createOidcRouter, type OidcRouterDeps } from '../oidc.js';
import { createSessionJwtMinter } from '../../../providers/auth/session-jwt.js';
import type { OidcProvider } from '../../../providers/auth/oidc-provider.js';

interface TestResponse {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
}

const CLIENT_SECRET = 'test-client-secret-with-enough-entropy';
const CALLBACK_URL = 'https://dominus.app/api/v1/auth/oidc/callback';
const APP_ORIGIN = 'https://dominus.app/';

function makeProvider(): OidcProvider {
  return {
    isEnabled: true,
    buildAuthorizeUrl: vi.fn((input) => {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: 'client-123',
        redirect_uri: input.redirectUri,
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      });
      return `https://idp.example.com/authorize?${params.toString()}`;
    }),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'at-1',
      idToken: 'id-1',
      expiresIn: 3600,
    }),
    validateIdToken: vi.fn().mockResolvedValue({
      authenticated: true,
      userId: 'user-1',
      tenantId: 'org-42',
      role: 'admin',
    }),
    logoutUrl: vi.fn(() => 'https://idp.example.com/v2/logout'),
  };
}

function buildApp(overrides: Partial<OidcRouterDeps> = {}): {
  app: Application;
  provider: OidcProvider;
} {
  const sessionJwt = createSessionJwtMinter(CLIENT_SECRET, 8);
  const provider = makeProvider();
  const deps: OidcRouterDeps = {
    provider,
    clientSecret: CLIENT_SECRET,
    callbackUrl: CALLBACK_URL,
    appOrigin: APP_ORIGIN,
    sessionTtlMs: 8 * 60 * 60 * 1000,
    sessionVerifier: sessionJwt,
    mintSession: (sub, tenantId, role) => sessionJwt.mint({ sub, tenantId, role }),
    ...overrides,
  };
  const app = express();
  app.use('/api/v1/auth/oidc', createOidcRouter(deps));
  return { app, provider };
}

function cookieOf(res: TestResponse, name: string): string {
  const setCookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const found = setCookies?.find((c) => c.startsWith(`${name}=`));
  expect(found).toBeTruthy();
  return found as string;
}

function cookieValueOf(res: TestResponse, name: string): string {
  const cookie = cookieOf(res, name);
  const eq = cookie.indexOf('=');
  return cookie.slice(eq + 1).split(';')[0] as string;
}

function locationOf(res: TestResponse): string {
  return res.headers.location as string;
}

describe('API: /api/v1/auth/oidc/start', () => {
  it('sets a transient httpOnly cookie and redirects to the IdP', async () => {
    const { app, provider } = buildApp();
    const res = await request(app).get('/api/v1/auth/oidc/start');

    expect(res.status).toBe(302);
    const location = new URL(locationOf(res));
    expect(location.origin).toBe('https://idp.example.com');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(cookieOf(res, 'dominus_oidc')).toContain('HttpOnly');
    expect(provider.buildAuthorizeUrl).toHaveBeenCalledTimes(1);
  });
});

describe('API: /api/v1/auth/oidc/callback', () => {
  it('exchanges the code and sets the session cookie', async () => {
    const { app, provider } = buildApp();
    const start = await request(app).get('/api/v1/auth/oidc/start');
    const cookie = cookieOf(start, 'dominus_oidc');
    const state = new URL(locationOf(start)).searchParams.get('state') as string;

    const res = await request(app)
      .get(`/api/v1/auth/oidc/callback?code=code-1&state=${state}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe('https://dominus.app');
    expect(provider.exchangeCode).toHaveBeenCalledTimes(1);
    const sessionCookie = cookieOf(res, 'dominus_session');
    expect(sessionCookie).toContain('HttpOnly');
    const sessionValue = cookieValueOf(res, 'dominus_session');
    const claims = await createSessionJwtMinter(CLIENT_SECRET, 8).verify(sessionValue);
    expect(claims).toEqual({ sub: 'user-1', tenantId: 'org-42', role: 'admin' });
  });

  it('rejects a state mismatch (CSRF) and redirects to the app with an error', async () => {
    const { app, provider } = buildApp();
    const start = await request(app).get('/api/v1/auth/oidc/start');
    const cookie = cookieOf(start, 'dominus_oidc');

    const res = await request(app)
      .get('/api/v1/auth/oidc/callback?code=code-1&state=attacker-state')
      .set('Cookie', cookie);

    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe('https://dominus.app/?sso_error=authentication_failed');
    expect(provider.exchangeCode).not.toHaveBeenCalled();
  });

  it('rejects a callback without the transient cookie', async () => {
    const { app, provider } = buildApp();
    const res = await request(app).get('/api/v1/auth/oidc/callback?code=code-1&state=whatever');
    expect(res.status).toBe(302);
    expect(locationOf(res)).toContain('sso_error=authentication_failed');
    expect(provider.exchangeCode).not.toHaveBeenCalled();
  });

  it('fails closed when the IdP rejects the code', async () => {
    const { app, provider } = buildApp();
    vi.mocked(provider.exchangeCode).mockRejectedValue(new Error('invalid_grant'));
    const start = await request(app).get('/api/v1/auth/oidc/start');
    const cookie = cookieOf(start, 'dominus_oidc');
    const state = new URL(locationOf(start)).searchParams.get('state') as string;

    const res = await request(app)
      .get(`/api/v1/auth/oidc/callback?code=code-bad&state=${state}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(302);
    expect(locationOf(res)).toContain('sso_error=authentication_failed');
    const setCookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookies?.some((c) => c.startsWith('dominus_session='))).toBe(false);
  });

  it('fails closed when the ID token does not validate', async () => {
    const { app, provider } = buildApp();
    vi.mocked(provider.validateIdToken).mockResolvedValue({ authenticated: false });
    const start = await request(app).get('/api/v1/auth/oidc/start');
    const cookie = cookieOf(start, 'dominus_oidc');
    const state = new URL(locationOf(start)).searchParams.get('state') as string;

    const res = await request(app)
      .get(`/api/v1/auth/oidc/callback?code=code-1&state=${state}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(302);
    expect(locationOf(res)).toContain('sso_error=authentication_failed');
  });
});

describe('API: /api/v1/auth/oidc/me', () => {
  it('returns the session claims when the cookie is valid', async () => {
    const { app } = buildApp();
    const sessionJwt = createSessionJwtMinter(CLIENT_SECRET, 8);
    const session = await sessionJwt.mint({ sub: 'user-1', tenantId: 'org-42', role: 'admin' });

    const res = await request(app)
      .get('/api/v1/auth/oidc/me')
      .set('Cookie', `dominus_session=${session}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authenticated: true,
      sub: 'user-1',
      tenantId: 'org-42',
      role: 'admin',
    });
  });

  it('returns 401 without a session cookie', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/auth/oidc/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });
  });

  it('returns 401 for a tampered session cookie', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/v1/auth/oidc/me')
      .set('Cookie', 'dominus_session=tampered.token.value');
    expect(res.status).toBe(401);
  });
});

describe('API: /api/v1/auth/oidc/logout', () => {
  it('clears the session cookie', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/oidc/logout')
      .set('Cookie', 'dominus_session=anything');
    expect(res.status).toBe(204);
    const cleared = res.headers['set-cookie']?.[0] as string;
    expect(cleared).toContain('dominus_session=');
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });
});
