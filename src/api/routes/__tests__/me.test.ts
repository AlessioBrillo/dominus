// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createMeRouter } from '../me.js';

function app(auth?: Request['auth'], tenantId?: string): express.Express {
  const a = express();
  a.use((req: Request, _res: Response, next: NextFunction) => {
    if (auth) req.auth = auth;
    if (tenantId) req.tenantId = tenantId;
    next();
  });
  a.use('/api/v1/me', createMeRouter());
  return a;
}

describe('API: /api/v1/me', () => {
  it('reports the effective role and tenant', async () => {
    const res = await request(app({ role: 'operator', userId: 'u1', tenantId: 't1' }, 't1')).get(
      '/api/v1/me',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantId: 't1', role: 'operator', userId: 'u1', keyName: null });
  });

  it('answers with nulls for an unauthenticated community install', async () => {
    const res = await request(app()).get('/api/v1/me');
    expect(res.body).toEqual({ tenantId: 'default', role: null, userId: null, keyName: null });
  });

  it('never returns key material', async () => {
    const res = await request(app({ role: 'admin', keyName: 'ci-key' }, 't1')).get('/api/v1/me');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|hash|token/i);
  });
});
