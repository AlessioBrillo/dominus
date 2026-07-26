import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requireRole } from '../require-role.js';
import type { Request, Response, NextFunction } from 'express';

function buildApp(auth?: { role?: string }): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (auth) req.auth = auth;
    next();
  });
  app.get('/admin-only', requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireRole', () => {
  it('allows a request with a matching role', async () => {
    const res = await request(buildApp({ role: 'admin' })).get('/admin-only');
    expect(res.status).toBe(200);
  });

  it('rejects a request with a non-matching role', async () => {
    const res = await request(buildApp({ role: 'member' })).get('/admin-only');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a request with no req.auth at all', async () => {
    const res = await request(buildApp()).get('/admin-only');
    expect(res.status).toBe(403);
  });
});
