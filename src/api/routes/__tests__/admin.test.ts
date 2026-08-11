// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { AdminService } from '../../../services/admin-service.js';
import type { AdminOverview, AdminTenantSummary } from '../../../types/admin.js';

function makeStubService(): AdminService {
  return {
    overview: vi.fn().mockResolvedValue({
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      tenantsCount: 3,
      activeSubscriptions: 2,
      paidPlans: 2,
      candidatesScoredTotal: 35,
      apiCallsTotal: 350,
    } as AdminOverview),
    listTenants: vi.fn().mockResolvedValue([
      {
        tenantId: 'tenant-a',
        plan: 'pro',
        status: 'active',
        apiKeyCount: 2,
        lastActiveAt: '2026-08-06T10:00:00Z',
        usage: [
          { feature: 'candidates_scored', used: 20, limit: 500 },
          { feature: 'api_calls', used: 5, limit: 10000 },
          { feature: 'domains_tracked', used: 0, limit: 250 },
        ],
      },
    ] as AdminTenantSummary[]),
  } as unknown as AdminService;
}

function buildApp(service?: AdminService, role: string = 'admin'): Application {
  const app = express();
  app.use(express.json());

  // Emulates createAuthMiddleware for role-gated requests. An empty string
  // simulates an authenticated caller with no role.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = 'platform';
    if (role) {
      req.auth = { role, tenantId: 'platform', userId: undefined };
    }
    next();
  });

  app.use('/api/v1/admin', createAdminRouter(service ?? makeStubService()));
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/admin', () => {
  describe('GET /overview', () => {
    it('returns platform-wide totals', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/overview');
      expect(res.status).toBe(200);
      expect(res.body.tenantsCount).toBe(3);
      expect(res.body.activeSubscriptions).toBe(2);
      expect(res.body.candidatesScoredTotal).toBe(35);
    });
  });

  describe('GET /tenants', () => {
    it('returns per-tenant summaries with usage', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/tenants');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].tenantId).toBe('tenant-a');
      expect(res.body[0].usage).toHaveLength(3);
    });
  });

  describe('role gate', () => {
    it('rejects non-admin callers with 403', async () => {
      const res = await request(buildApp(makeStubService(), 'member')).get(
        '/api/v1/admin/overview',
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects callers without a role with 403', async () => {
      const res = await request(buildApp(makeStubService(), '')).get('/api/v1/admin/tenants');
      expect(res.status).toBe(403);
    });
  });
});
