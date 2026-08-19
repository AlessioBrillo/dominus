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

function buildApp(requireTenant = false): Application {
  const sessionJwt = createSessionJwtMinter(SECRET, 8);
  const app = express();
  app.use(
    '/api/v1/auth/protected',
    createAuthMiddleware(makeAuthProvider(), db, {
      requireTenant,
      sessionVerifier: sessionJwt,
    }),
  );
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
