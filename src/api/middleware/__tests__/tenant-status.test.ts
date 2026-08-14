// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTenantStatusMiddleware } from '../tenant-status.js';
import type { Request, Response, NextFunction } from 'express';
import type { AdminRepository } from '../../../db/repositories/admin-repository.js';
import type { TenantAdminFlag } from '../../../types/admin.js';

function makeStubRepo(suspended: boolean): AdminRepository {
  return {
    getAdminFlag: async (): Promise<TenantAdminFlag | null> =>
      suspended
        ? {
            tenantId: 'tenant-a',
            suspendedAt: '2026-08-13T10:00:00Z',
            suspendedReason: 'abuse',
            planOverride: null,
            updatedAt: '2026-08-13T10:00:00Z',
          }
        : null,
  } as unknown as AdminRepository;
}

interface Auth {
  role?: string;
  tenantId?: string;
}

function buildApp(repo: AdminRepository, auth?: Auth): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = auth?.tenantId ?? 'tenant-a';
    if (auth?.role) req.auth = { role: auth.role, tenantId: 'tenant-a', userId: undefined };
    next();
  });
  app.use(createTenantStatusMiddleware(repo));
  app.get('/protected', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/billing/portal', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createTenantStatusMiddleware (ADR-0057)', () => {
  it('allows a request when the tenant is not suspended', async () => {
    const res = await request(buildApp(makeStubRepo(false))).get('/protected');
    expect(res.status).toBe(200);
  });

  it('blocks a suspended tenant with 403 TENANT_SUSPENDED', async () => {
    const res = await request(buildApp(makeStubRepo(true))).get('/protected');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
    expect(res.body.error.context.tenantId).toBe('tenant-a');
  });

  it('allows a suspended tenant to reach the /billing escape hatch', async () => {
    const res = await request(buildApp(makeStubRepo(true))).get('/billing/portal');
    expect(res.status).toBe(200);
  });

  it('always allows admin-role callers (operator keys)', async () => {
    const res = await request(buildApp(makeStubRepo(true), { role: 'admin' })).get('/protected');
    expect(res.status).toBe(200);
  });

  it('never blocks when the flag table is empty (community default)', async () => {
    const res = await request(buildApp(makeStubRepo(false))).get('/protected');
    expect(res.status).toBe(200);
  });
});
