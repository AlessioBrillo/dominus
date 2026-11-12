// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createUsageEnforcementMiddleware } from '../usage-enforcement.js';
import type { UsageMeterService } from '../../../services/usage-meter-service.js';

function buildApp(usageService: Partial<UsageMeterService>, enabled = true): Application {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.tenantId = 'tenant-1';
    next();
  });
  app.use(createUsageEnforcementMiddleware(usageService as UsageMeterService, enabled));
  app.get('/portfolio', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.post('/portfolio', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  return app;
}

describe('usage enforcement middleware', () => {
  it('does not meter the reads of the dashboard', async () => {
    const record = vi.fn(async () => ({}));
    const app = buildApp({ record } as unknown as UsageMeterService);

    await request(app).get('/portfolio');

    expect(record).not.toHaveBeenCalled();
  });

  it('meters the writes', async () => {
    const record = vi.fn(async (..._args: unknown[]) => ({}));
    const app = buildApp({ record } as unknown as UsageMeterService);

    await request(app).post('/portfolio').send({ domain: 'alpha.com' });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toBe('tenant-1');
    expect(record.mock.calls[0]?.[1]).toBe('api_calls');
  });

  it('meters the reads when the deployment asks for it', async () => {
    const record = vi.fn(async () => ({}));
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.tenantId = 'tenant-1';
      next();
    });
    app.use(createUsageEnforcementMiddleware(usageServiceWith(record), true, { meterReads: true }));
    app.get('/portfolio', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    await request(app).get('/portfolio');

    expect(record).toHaveBeenCalledTimes(1);
  });

  it('never meters the control-plane routes', async () => {
    const record = vi.fn(async () => ({}));
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.tenantId = 'tenant-1';
      next();
    });
    app.use(createUsageEnforcementMiddleware(usageServiceWith(record), true, { meterReads: true }));
    app.post('/billing/checkout', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    await request(app).post('/billing/checkout').send({});

    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing when the enforcement is disabled', async () => {
    const record = vi.fn(async () => ({}));
    const app = buildApp({ record } as unknown as UsageMeterService, false);

    await request(app).post('/portfolio').send({});

    expect(record).not.toHaveBeenCalled();
  });

  it('answers 429 when the limit is exhausted', async () => {
    const record = vi.fn(async () => {
      throw new (await import('../../../types/errors.js')).UsageLimitExceededError(
        'api_calls',
        1000,
        1,
        1000,
      );
    });
    const app = buildApp({ record } as unknown as UsageMeterService);

    const res = await request(app).post('/portfolio').send({});

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('USAGE_LIMIT_EXCEEDED');
  });
});

function usageServiceWith(record: ReturnType<typeof vi.fn>): UsageMeterService {
  return { record } as unknown as UsageMeterService;
}
