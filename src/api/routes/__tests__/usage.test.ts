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

  describe('GET /history', () => {
    it('returns the usage history for the tenant', async () => {
      const service = makeStubService();
      (service.getUsageHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          periodStart: '2026-05-01',
          periodEnd: '2026-05-31',
          plan: 'free',
          usage: {
            candidates_scored: {
              feature: 'candidates_scored',
              currentUsage: 0,
              limitValue: 50,
              remaining: 50,
              isOverLimit: false,
              plan: 'free',
              periodStart: '2026-05-01',
              periodEnd: '2026-05-31',
            },
            api_calls: {
              feature: 'api_calls',
              currentUsage: 0,
              limitValue: 1000,
              remaining: 1000,
              isOverLimit: false,
              plan: 'free',
              periodStart: '2026-05-01',
              periodEnd: '2026-05-31',
            },
            domains_tracked: {
              feature: 'domains_tracked',
              currentUsage: 0,
              limitValue: 25,
              remaining: 25,
              isOverLimit: false,
              plan: 'free',
              periodStart: '2026-05-01',
              periodEnd: '2026-05-31',
            },
          },
        },
      ] as never);

      const res = await request(buildApp(service)).get('/api/v1/usage/history?months=3');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toHaveProperty('periodStart');
      expect(res.body[0].usage.candidates_scored.currentUsage).toBe(0);
    });

    it('defaults to 6 months when months is omitted', async () => {
      const service = makeStubService();
      (service.getUsageHistory as ReturnType<typeof vi.fn>).mockResolvedValue([] as never);

      const res = await request(buildApp(service)).get('/api/v1/usage/history');
      expect(res.status).toBe(200);
      expect(service.getUsageHistory).toHaveBeenCalledWith('default', 6);
    });

    it('returns 400 when months is out of range', async () => {
      const res = await request(buildApp()).get('/api/v1/usage/history?months=0');
      expect(res.status).toBe(400);
    });

    it('returns 400 when months exceeds the 24-month cap', async () => {
      const res = await request(buildApp()).get('/api/v1/usage/history?months=25');
      expect(res.status).toBe(400);
    });

    it('returns 400 when months is not a number', async () => {
      const res = await request(buildApp()).get('/api/v1/usage/history?months=abc');
      expect(res.status).toBe(400);
    });
  });
});
