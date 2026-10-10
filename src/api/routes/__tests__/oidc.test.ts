// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createOidcRouter, type OidcRouterDeps } from '../oidc.js';
import { createSessionJwtMinter } from '../../../providers/auth/session-jwt.js';
import type { OidcProvider } from '../../../providers/auth/oidc-provider.js';
import {
  InvitationEmailMismatchError,
  InvitationInvalidError,
  TeamSeatLimitError,
} from '../../../services/team-service.js';

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
    trustedOrigins: new Set([new URL(APP_ORIGIN).origin]),
    mintSession: (sub, tenantId, role, email) =>
      sessionJwt.mint({ sub, tenantId, role, ...(email !== undefined ? { email } : {}) }),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
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
  it('clears the session cookie and returns the IdP logout URL', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/oidc/logout')
      .set('Origin', new URL(APP_ORIGIN).origin)
      .set('Cookie', 'dominus_session=anything');
    expect(res.status).toBe(200);
    expect(res.body.logoutUrl).toBe('https://idp.example.com/v2/logout');
    const cleared = res.headers['set-cookie']?.[0] as string;
    expect(cleared).toContain('dominus_session=');
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it('rejects a logout POST from an untrusted origin (CSRF)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/v1/auth/oidc/logout')
      .set('Origin', 'https://evil.example')
      .set('Cookie', 'dominus_session=anything');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('API: /api/v1/auth/oidc/me — operator role', () => {
  it('reports operator for an allowlisted subject even if the session says admin', async () => {
    const { app } = buildApp({ operatorSubjects: new Set(['user-1']) });
    const session = await createSessionJwtMinter(CLIENT_SECRET, 8).mint({
      sub: 'user-1',
      tenantId: 'org-42',
      role: 'admin',
    });
    const res = await request(app)
      .get('/api/v1/auth/oidc/me')
      .set('Cookie', `dominus_session=${session}`);
    expect((res.body as { role: string }).role).toBe('operator');
  });

  it('never reports operator from the session claim alone', async () => {
    const { app } = buildApp();
    const session = await createSessionJwtMinter(CLIENT_SECRET, 8).mint({
      sub: 'user-1',
      tenantId: 'org-42',
      role: 'operator',
    });
    const res = await request(app)
      .get('/api/v1/auth/oidc/me')
      .set('Cookie', `dominus_session=${session}`);
    expect((res.body as { role: string }).role).toBe('admin');
  });
});

describe('API: /api/v1/auth/oidc/accept-invitation', () => {
  const ORIGIN = new URL(APP_ORIGIN).origin;
  const TOKEN = 'a'.repeat(43);

  async function sessionCookie(): Promise<string> {
    const session = await createSessionJwtMinter(CLIENT_SECRET, 8).mint({
      sub: 'user-9',
      tenantId: 'personal-tenant',
      role: 'admin',
    });
    return `dominus_session=${session}`;
  }

  const post = async (
    app: Application,
    opts: { cookie?: string; origin?: string; body?: unknown } = {},
  ): Promise<request.Response> => {
    let req = request(app).post('/api/v1/auth/oidc/accept-invitation');
    if (opts.cookie) req = req.set('Cookie', opts.cookie);
    req = req.set('Origin', opts.origin ?? ORIGIN);
    return req.send(opts.body ?? { token: TOKEN });
  };

  it('is disabled (404) when invitations are not wired', async () => {
    const { app } = buildApp();
    expect((await post(app, { cookie: await sessionCookie() })).status).toBe(404);
  });

  it('joins the team and re-issues the session for the new tenant', async () => {
    const acceptInvitation = vi.fn().mockResolvedValue({ tenantId: 'team-7', role: 'member' });
    const { app } = buildApp({ acceptInvitation });

    const res = await post(app, { cookie: await sessionCookie() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantId: 'team-7', role: 'member' });
    expect(acceptInvitation).toHaveBeenCalledWith(TOKEN, 'user-9', undefined);

    // The new cookie carries the team tenant, minted by the same signer.
    const renewed = cookieValueOf(res, 'dominus_session');
    const me = await request(app)
      .get('/api/v1/auth/oidc/me')
      .set('Cookie', `dominus_session=${renewed}`);
    expect(me.body).toMatchObject({ sub: 'user-9', tenantId: 'team-7', role: 'member' });
  });

  it('passes the verified email from the session and keeps it in the renewed session', async () => {
    const acceptInvitation = vi.fn().mockResolvedValue({ tenantId: 'team-7', role: 'member' });
    const { app } = buildApp({ acceptInvitation });
    const session = await createSessionJwtMinter(CLIENT_SECRET, 8).mint({
      sub: 'user-9',
      tenantId: 'personal-tenant',
      role: 'admin',
      email: 'bob@example.com',
    });

    const res = await post(app, { cookie: `dominus_session=${session}` });

    expect(acceptInvitation).toHaveBeenCalledWith(TOKEN, 'user-9', 'bob@example.com');
    const renewed = cookieValueOf(res, 'dominus_session');
    const verified = await createSessionJwtMinter(CLIENT_SECRET, 8).verify(renewed);
    expect(verified).toMatchObject({ sub: 'user-9', tenantId: 'team-7', email: 'bob@example.com' });
  });

  it('answers 403 INVITATION_EMAIL_MISMATCH when the identity is not the invited one', async () => {
    const { app } = buildApp({
      acceptInvitation: vi
        .fn()
        .mockRejectedValue(new InvitationEmailMismatchError('different-email')),
    });
    const res = await post(app, { cookie: await sessionCookie() });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('requires a session', async () => {
    const { app } = buildApp({ acceptInvitation: vi.fn() });
    expect((await post(app)).status).toBe(401);
  });

  it('rejects an untrusted origin (CSRF)', async () => {
    const acceptInvitation = vi.fn();
    const { app } = buildApp({ acceptInvitation });
    const res = await post(app, { cookie: await sessionCookie(), origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(acceptInvitation).not.toHaveBeenCalled();
  });

  it('validates the token shape', async () => {
    const { app } = buildApp({ acceptInvitation: vi.fn() });
    const res = await post(app, { cookie: await sessionCookie(), body: { token: 'short' } });
    expect(res.status).toBe(400);
  });

  it('maps an invalid invitation to 400 and a full team to 409', async () => {
    const invalid = buildApp({
      acceptInvitation: vi.fn().mockRejectedValue(new InvitationInvalidError()),
    });
    const res1 = await post(invalid.app, { cookie: await sessionCookie() });
    expect(res1.status).toBe(400);
    expect((res1.body as { error: { code: string } }).error.code).toBe('INVITATION_INVALID');

    const full = buildApp({
      acceptInvitation: vi.fn().mockRejectedValue(new TeamSeatLimitError(3, 3)),
    });
    const res2 = await post(full.app, { cookie: await sessionCookie() });
    expect(res2.status).toBe(409);
  });
});
