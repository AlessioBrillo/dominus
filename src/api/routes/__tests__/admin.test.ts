// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { AdminService } from '../../../services/admin-service.js';
import type {
  AdminOverview,
  AdminTenantSummary,
  AdminTenantDetail,
  AdminUsageSeriesPoint,
  TenantAdminFlag,
} from '../../../types/admin.js';

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
        suspended: false,
        usage: [
          { feature: 'candidates_scored', used: 20, limit: 500 },
          { feature: 'api_calls', used: 5, limit: 10000 },
          { feature: 'domains_tracked', used: 0, limit: 250 },
        ],
      },
    ] as AdminTenantSummary[]),
    tenantDetail: vi.fn().mockResolvedValue({
      tenantId: 'tenant-a',
      plan: 'pro',
      status: 'active',
      apiKeyCount: 2,
      lastActiveAt: '2026-08-06T10:00:00Z',
      suspended: false,
      usage: [],
      flags: {
        tenantId: 'tenant-a',
        suspendedAt: null,
        suspendedReason: null,
        planOverride: 'enterprise',
        updatedAt: null,
      } satisfies TenantAdminFlag,
    } as AdminTenantDetail),
    tenantUsageSeries: vi
      .fn()
      .mockResolvedValue([
        { date: '2026-08-05', feature: 'api_calls', amount: 3 },
      ] as AdminUsageSeriesPoint[]),
    suspendTenant: vi.fn().mockResolvedValue({
      tenantId: 'tenant-a',
      suspendedAt: '2026-08-13T10:00:00Z',
      suspendedReason: 'abuse',
      planOverride: null,
      updatedAt: '2026-08-13T10:00:00Z',
    } satisfies TenantAdminFlag),
    unsuspendTenant: vi.fn().mockResolvedValue({
      tenantId: 'tenant-a',
      suspendedAt: null,
      suspendedReason: null,
      planOverride: null,
      updatedAt: null,
    } satisfies TenantAdminFlag),
    setPlanOverride: vi.fn().mockResolvedValue({
      tenantId: 'tenant-a',
      suspendedAt: null,
      suspendedReason: null,
      planOverride: 'enterprise',
      updatedAt: '2026-08-13T10:00:00Z',
    } satisfies TenantAdminFlag),
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
      expect(res.body[0].suspended).toBe(false);
    });
  });

  describe('GET /tenants/:tenantId', () => {
    it('returns tenant detail including operator flags', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/tenants/tenant-a');
      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('tenant-a');
      expect(res.body.flags.planOverride).toBe('enterprise');
    });

    it('returns 404 for an unknown tenant', async () => {
      const service = makeStubService();
      service.tenantDetail = vi.fn().mockResolvedValue(null);
      const res = await request(buildApp(service)).get('/api/v1/admin/tenants/ghost');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /tenants/:tenantId/usage', () => {
    it('returns the daily usage series', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/tenants/tenant-a/usage');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toEqual({ date: '2026-08-05', feature: 'api_calls', amount: 3 });
    });

    it('forwards the days window to the service', async () => {
      const service = makeStubService();
      await request(buildApp(service)).get('/api/v1/admin/tenants/tenant-a/usage?days=7');
      expect(service.tenantUsageSeries).toHaveBeenCalledWith(
        'tenant-a',
        expect.stringContaining('2026-08-'),
      );
    });

    it('rejects an invalid days value with 400', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/tenants/tenant-a/usage?days=abc');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects days out of range with 400', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/tenants/tenant-a/usage?days=999');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /tenants/:tenantId/suspend', () => {
    it('suspends a tenant with a reason', async () => {
      const res = await request(buildApp())
        .post('/api/v1/admin/tenants/tenant-a/suspend')
        .send({ reason: 'Payment overdue' });
      expect(res.status).toBe(200);
      expect(res.body.suspendedAt).not.toBeNull();
      expect(res.body.suspendedReason).toBe('abuse');
    });

    it('accepts a missing reason', async () => {
      const res = await request(buildApp()).post('/api/v1/admin/tenants/tenant-a/suspend');
      expect(res.status).toBe(200);
    });

    it('rejects a non-string reason with 400', async () => {
      const res = await request(buildApp())
        .post('/api/v1/admin/tenants/tenant-a/suspend')
        .send({ reason: 42 });
      expect(res.status).toBe(400);
    });

    it('rejects an over-long reason with 400', async () => {
      const res = await request(buildApp())
        .post('/api/v1/admin/tenants/tenant-a/suspend')
        .send({ reason: 'x'.repeat(501) });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /tenants/:tenantId/unsuspend', () => {
    it('clears the suspension flag', async () => {
      const res = await request(buildApp()).post('/api/v1/admin/tenants/tenant-a/unsuspend');
      expect(res.status).toBe(200);
      expect(res.body.suspendedAt).toBeNull();
    });
  });

  describe('POST /tenants/:tenantId/plan-override', () => {
    it('sets a plan override', async () => {
      const res = await request(buildApp())
        .post('/api/v1/admin/tenants/tenant-a/plan-override')
        .send({ plan: 'enterprise' });
      expect(res.status).toBe(200);
      expect(res.body.planOverride).toBe('enterprise');
    });

    it('clears the override when plan is null', async () => {
      const res = await request(buildApp())
        .post('/api/v1/admin/tenants/tenant-a/plan-override')
        .send({ plan: null });
      expect(res.status).toBe(200);
    });

    it('rejects an invalid plan with 400', async () => {
      const res = await request(buildApp())
        .post('/api/v1/admin/tenants/tenant-a/plan-override')
        .send({ plan: 'gold' });
      expect(res.status).toBe(400);
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
