// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSustainabilityRouter } from '../sustainability.js';
import { errorHandler } from '../../middleware/error-handler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockService(): any {
  return {
    getAllVerdicts: vi.fn().mockResolvedValue([
      {
        domain: 'vintagecoffee.com',
        verdict: 'loss',
        annualRevenueEur: 1.2,
        annualCarryCostEur: 12,
        netAnnualEur: -10.8,
        reason: 'does not cover the renewal',
      },
    ]),
    getDomainVerdict: vi.fn().mockResolvedValue({
      domain: 'vintagecoffee.com',
      verdict: 'loss',
      annualRevenueEur: 1.2,
      annualCarryCostEur: 12,
      netAnnualEur: -10.8,
      reason: 'does not cover the renewal',
    }),
  };
}

describe('Sustainability API', () => {
  it('returns the portfolio verdicts', async () => {
    const app = express();
    app.use(express.json());
    app.use('/sustainability', createSustainabilityRouter(mockService()));
    app.use(errorHandler);

    const res = await request(app).get('/sustainability');

    expect(res.status).toBe(200);
    expect(res.body.verdicts).toHaveLength(1);
    expect(res.body.verdicts[0].verdict).toBe('loss');
  });

  it('returns one domain verdict', async () => {
    const app = express();
    app.use(express.json());
    app.use('/sustainability', createSustainabilityRouter(mockService()));
    app.use(errorHandler);

    const res = await request(app).get('/sustainability/vintagecoffee.com');

    expect(res.status).toBe(200);
    expect(res.body.verdict.domain).toBe('vintagecoffee.com');
  });

  it('returns 404 for a domain outside the portfolio', async () => {
    const service = mockService();
    service.getDomainVerdict.mockResolvedValue(null);
    const app = express();
    app.use(express.json());
    app.use('/sustainability', createSustainabilityRouter(service));
    app.use(errorHandler);

    const res = await request(app).get('/sustainability/other.com');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
