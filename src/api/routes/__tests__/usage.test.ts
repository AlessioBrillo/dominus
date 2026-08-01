// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createUsageRouter } from '../usage.js';
import { errorHandler } from '../../middleware/error-handler.js';
import type { UsageMeterService } from '../../../services/usage-meter-service.js';
import type { UsageForPeriod, PlanLimit } from '../../../types/usage.js';
import { UsageLimitExceededError } from '../../../types/errors.js';

function makeStubService(): UsageMeterService {
  return {
    record: vi.fn().mockResolvedValue({
      feature: 'candidates_scored',
      currentUsage: 5,
      limitValue: 50,
      remaining: 45,
      isOverLimit: false,
      plan: 'free',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
    } as UsageForPeriod),
    check: vi.fn().mockResolvedValue({
      feature: 'candidates_scored',
      currentUsage: 5,
      limitValue: 50,
      remaining: 45,
      isOverLimit: false,
      plan: 'free',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
    } as UsageForPeriod),
    getUsageForPeriod: vi.fn().mockResolvedValue({
      feature: 'candidates_scored',
      currentUsage: 5,
      limitValue: 50,
      remaining: 45,
      isOverLimit: false,
      plan: 'free',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
    } as UsageForPeriod),
    getAllPlanLimitsForTenant: vi.fn().mockResolvedValue([
      { plan: 'free', feature: 'candidates_scored', limitValue: 50 },
      { plan: 'free', feature: 'api_calls', limitValue: 1000 },
      { plan: 'free', feature: 'domains_tracked', limitValue: 25 },
    ] as PlanLimit[]),
  } as unknown as UsageMeterService;
}

function buildApp(service?: UsageMeterService): Application {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/usage', createUsageRouter(service ?? makeStubService()));
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/usage', () => {
  describe('GET /', () => {
    it('returns usage info for default period', async () => {
      const res = await request(buildApp()).get('/api/v1/usage?feature=candidates_scored');
      expect(res.status).toBe(200);
      expect(res.body.feature).toBe('candidates_scored');
      expect(res.body.currentUsage).toBe(5);
      expect(res.body.limitValue).toBe(50);
      expect(res.body.remaining).toBe(45);
      expect(res.body.isOverLimit).toBe(false);
    });

    it('returns 400 when feature is missing', async () => {
      const res = await request(buildApp()).get('/api/v1/usage');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /record', () => {
    it('records usage and returns updated info', async () => {
      const res = await request(buildApp())
        .post('/api/v1/usage/record')
        .send({ feature: 'candidates_scored', amount: 1 });
      expect(res.status).toBe(200);
      expect(res.body.feature).toBe('candidates_scored');
      expect(res.body.currentUsage).toBe(5);
    });

    it('returns 400 when feature is missing', async () => {
      const res = await request(buildApp()).post('/api/v1/usage/record').send({ amount: 1 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when amount is invalid', async () => {
      const res = await request(buildApp())
        .post('/api/v1/usage/record')
        .send({ feature: 'candidates_scored', amount: 0 });
      expect(res.status).toBe(400);
    });

    it('returns 429 when over limit', async () => {
      const service = makeStubService();
      (service.record as ReturnType<typeof vi.fn>).mockRejectedValue(
        new UsageLimitExceededError('candidates_scored', 50, 1, 50),
      );
      const res = await request(buildApp(service))
        .post('/api/v1/usage/record')
        .send({ feature: 'candidates_scored', amount: 1 });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('USAGE_LIMIT_EXCEEDED');
    });
  });

  describe('GET /limits', () => {
    it('returns plan limits list for tenant plan', async () => {
      const res = await request(buildApp()).get('/api/v1/usage/limits');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(3);
      expect(res.body[0]).toHaveProperty('plan');
      expect(res.body[0]).toHaveProperty('feature');
      expect(res.body[0]).toHaveProperty('limitValue');
    });
  });
});
