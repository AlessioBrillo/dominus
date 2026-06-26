import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';

function buildApp(authProvider: AuthProvider): express.Express {
  const app = express();
  app.use('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/v1/protected', createAuthMiddleware(authProvider), (_req, res) => {
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
