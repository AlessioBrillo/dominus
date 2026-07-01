import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import type { DatabaseProvider, ExecResult } from '../../db/provider/interface.js';
import { createAuthRouter } from '../routes/auth.js';
import { DbApiKeyProvider } from '../../providers/auth/db-api-key-provider.js';
import type { ApiKeyRepository } from '../../db/repositories/api-key-repository.js';

function makeMockDb(): DatabaseProvider {
  return {
    exec: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: undefined } as ExecResult),
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    transaction: vi
      .fn()
      .mockImplementation(<T>(fn: (db: DatabaseProvider) => Promise<T>) =>
        fn({} as DatabaseProvider),
      ),
    close: vi.fn().mockResolvedValue(undefined),
    isOpen: vi.fn().mockReturnValue(true),
    backup: vi.fn(),
    runMigrations: vi.fn().mockResolvedValue(undefined),
    tryLock: vi.fn().mockResolvedValue(true),
    unlock: vi.fn().mockResolvedValue(undefined),
  };
}

// codeql[js/missing-rate-limiting] — test fixtures, not production routes
function buildApp(authProvider: AuthProvider): express.Express {
  const app = express();
  const mockDb = makeMockDb();
  app.use('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/v1/protected', createAuthMiddleware(authProvider, mockDb), (_req, res) => {
    res.json({ data: 'secret' });
  });
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  return app;
}

function makeAuthProvider(
  validate: AuthProvider['validate'] = vi.fn().mockResolvedValue({ authenticated: true }),
  isActive = true,
): AuthProvider {
  return { name: 'TestAuthProvider', isActive, validate };
}

describe('auth middleware', () => {
  describe('with authentication (auth enabled)', () => {
    let provider: AuthProvider;

    beforeEach(() => {
      provider = makeAuthProvider(
        vi.fn().mockImplementation(async (key: string) => ({
          authenticated: key === 'valid-key',
          keyName: key === 'valid-key' ? 'test' : undefined,
        })),
      );
    });

    it('returns 200 with valid API key in Bearer token', async () => {
      const app = buildApp(provider);
      const res = await request(app)
        .get('/api/v1/protected')
        .set('Authorization', 'Bearer valid-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: 'secret' });
    });

    it('returns 403 with invalid API key', async () => {
      const app = buildApp(provider);
      const res = await request(app)
        .get('/api/v1/protected')
        .set('Authorization', 'Bearer invalid-key');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 401 without Authorization header', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/v1/protected');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with malformed Authorization header', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/v1/protected').set('Authorization', 'Basic token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with empty Bearer token', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/v1/protected').set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('allows unauthenticated access to health endpoint', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('without authentication (auth disabled)', () => {
    let provider: AuthProvider;

    beforeEach(() => {
      provider = makeAuthProvider(vi.fn().mockResolvedValue({ authenticated: true }), false);
    });

    it('passes through without API key when auth is disabled', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/v1/protected');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: 'secret' });
    });
  });
});

describe('API key management endpoints', () => {
  function mockKeyRepo(): ApiKeyRepository {
    const keys: Array<{
      id: number; tenantId: string; name: string; keyHash: string;
      keyPrefix: string; role: string; expiresAt: string | null;
      lastUsedAt: string | null; createdAt: string;
    }> = [];
    return {
      create: vi.fn(async (input: {
        tenantId: string; name: string; keyHash: string;
        keyPrefix: string; role: string; expiresAt: string | null;
      }) => {
        const k = {
          id: keys.length + 1, ...input, lastUsedAt: null,
          createdAt: new Date().toISOString(),
        };
        keys.push(k);
        return k;
      }),
      findByTenant: vi.fn(async () => [...keys]),
      revoke: vi.fn(async (id: number) => {
        const i = keys.findIndex((k) => k.id === id);
        if (i >= 0) keys.splice(i, 1);
      }),
    } as unknown as ApiKeyRepository;
  }

  let provider: DbApiKeyProvider;
  let repo: ApiKeyRepository;

  beforeEach(() => {
    repo = mockKeyRepo();
    provider = new DbApiKeyProvider(repo);
  });

  it('POST /api-keys creates a key and returns it once', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', createAuthRouter(provider, repo));

    const res = await request(app)
      .post('/api/v1/auth/api-keys')
      .send({ name: 'my-key', role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('key');
    expect(res.body.name).toBe('my-key');
  });

  it('POST /api-keys returns 400 when name is missing', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', createAuthRouter(provider, repo));

    const res = await request(app)
      .post('/api/v1/auth/api-keys')
      .send({ role: 'admin' });

    expect(res.status).toBe(400);
  });

  it('GET /api-keys lists all keys for the tenant', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', createAuthRouter(provider, repo));

    await provider.generate({ tenantId: 'default', name: 'k1' });
    await provider.generate({ tenantId: 'default', name: 'k2' });

    const res = await request(app).get('/api/v1/auth/api-keys');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('DELETE /api-keys/:id revokes a key', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', createAuthRouter(provider, repo));

    const { id } = await provider.generate({ tenantId: 'default', name: 'del' });

    const res = await request(app).delete(`/api/v1/auth/api-keys/${id}`);
    expect(res.status).toBe(204);
  });
});
