// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../auth.js';
import { createSessionJwtMinter } from '../../../providers/auth/session-jwt.js';
import type { AuthProvider } from '../../../providers/auth/auth-provider.js';
import type { DatabaseProvider } from '../../../db/provider/interface.js';

const SECRET = 'test-client-secret-with-enough-entropy';

function makeAuthProvider(): AuthProvider {
  return {
    name: 'EnvApiKeyProvider',
    isActive: true,
    supportsKeyManagement: false,
    validate: vi.fn().mockResolvedValue({ authenticated: false }),
    asKeyManager: () => undefined,
  };
}

const db = {
  queryOne: vi.fn().mockResolvedValue(null),
  exec: vi.fn().mockResolvedValue(undefined),
} as unknown as DatabaseProvider;

beforeEach(() => {
  vi.clearAllMocks();
});

function buildApp(requireTenant = false, trustedOrigins?: ReadonlySet<string>): Application {
  const sessionJwt = createSessionJwtMinter(SECRET, 8);
  const app = express();
  app.use(
    '/api/v1/auth/protected',
    createAuthMiddleware(makeAuthProvider(), db, {
      requireTenant,
      sessionVerifier: sessionJwt,
      ...(trustedOrigins ? { trustedOrigins } : {}),
    }),
  );
  app.post('/api/v1/auth/protected/route', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/v1/auth/protected/route', (req, res) => {
    res.json({ ok: true, tenantId: req.tenantId, userId: req.auth?.userId });
  });
  return app;
}

describe('createAuthMiddleware — SSO session cookie fallback (ADR-0062)', () => {
  it('authenticates via the dominus_session cookie when no Bearer token is sent', async () => {
    const sessionJwt = createSessionJwtMinter(SECRET, 8);
    const session = await sessionJwt.mint({ sub: 'user-1', tenantId: 'org-42' });

    const res = await request(buildApp())
      .get('/api/v1/auth/protected/route')
      .set('Cookie', `dominus_session=${session}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tenantId: 'org-42', userId: 'user-1' });
  });

  it('requires a tenant when requireTenant is on (auth0 cloud mode)', async () => {
    const sessionJwt = createSessionJwtMinter(SECRET, 8);
    const session = await sessionJwt.mint({ sub: 'user-1' });

    const res = await request(buildApp(true))
      .get('/api/v1/auth/protected/route')
      .set('Cookie', `dominus_session=${session}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a tampered session cookie with 401', async () => {
    const res = await request(buildApp())
      .get('/api/v1/auth/protected/route')
      .set('Cookie', 'dominus_session=tampered.token.value');

    expect(res.status).toBe(401);
  });

  it('still requires a Bearer token when no cookie is present', async () => {
    const res = await request(buildApp()).get('/api/v1/auth/protected/route');
    expect(res.status).toBe(401);
  });
});

describe('createAuthMiddleware — CSRF guard on the session cookie', () => {
  const TRUSTED = new Set(['https://app.example.com']);

  async function cookie(): Promise<string> {
    const session = await createSessionJwtMinter(SECRET, 8).mint({ sub: 'user-1', tenantId: 't' });
    return `dominus_session=${session}`;
  }

  it('accepts a cookie-authenticated POST from a trusted origin', async () => {
    const res = await request(buildApp(false, TRUSTED))
      .post('/api/v1/auth/protected/route')
      .set('Origin', 'https://app.example.com')
      .set('Cookie', await cookie());
    expect(res.status).toBe(200);
  });

  it('rejects a cookie-authenticated POST from a foreign origin', async () => {
    const res = await request(buildApp(false, TRUSTED))
      .post('/api/v1/auth/protected/route')
      .set('Origin', 'https://evil.example')
      .set('Cookie', await cookie());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('rejects a cookie-authenticated POST with neither Origin nor Referer', async () => {
    const res = await request(buildApp(false, TRUSTED))
      .post('/api/v1/auth/protected/route')
      .set('Cookie', await cookie());
    expect(res.status).toBe(403);
  });

  it('falls back to the Referer origin when Origin is absent', async () => {
    const res = await request(buildApp(false, TRUSTED))
      .post('/api/v1/auth/protected/route')
      .set('Referer', 'https://app.example.com/team')
      .set('Cookie', await cookie());
    expect(res.status).toBe(200);
  });

  it('never blocks safe methods', async () => {
    const res = await request(buildApp(false, TRUSTED))
      .get('/api/v1/auth/protected/route')
      .set('Cookie', await cookie());
    expect(res.status).toBe(200);
  });

  it('refuses all cookie mutations when no trusted origin is configured', async () => {
    const res = await request(buildApp())
      .post('/api/v1/auth/protected/route')
      .set('Origin', 'https://app.example.com')
      .set('Cookie', await cookie());
    expect(res.status).toBe(403);
  });
});
