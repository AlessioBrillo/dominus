import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPurchaseRouter } from '../routes/purchase.js';
import { errorHandler } from '../middleware/error-handler.js';
import { PurchaseNotApprovedError } from '../../types/registrar.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockPurchaseService(): any {
  return {
    registrarName: 'test-registrar',
    preflight: vi.fn(),
    execute: vi.fn(),
    checkPrice: vi.fn(),
  };
}

describe('GET /api/purchase/preflight', () => {
  it('returns check result for a domain', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockResolvedValue({
      domain: 'example.com',
      available: true,
      registerPriceEur: 10,
      renewalPriceEur: 10,
      expectedValue: 500,
      confidence: 0.7,
      suggestedBuyMax: 250,
      trademarkClear: true,
      operatorApprovalRequired: false,
    });

    const app = express();
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/api/purchase/preflight?domain=example.com');
    expect(res.status).toBe(200);
    expect(res.body.check.available).toBe(true);
    expect(res.body.check.registerPriceEur).toBe(10);
  });

  it('returns 400 with missing domain', async () => {
    const svc = createMockPurchaseService();
    const app = express();
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/api/purchase/preflight');
    expect(res.status).toBe(400);
  });

  it('forwards errors to error handler', async () => {
    const svc = createMockPurchaseService();
    svc.preflight.mockRejectedValue(new Error('internal error'));

    const app = express();
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/api/purchase/preflight?domain=example.com');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/purchase/execute', () => {
  it('executes and returns purchase result', async () => {
    const svc = createMockPurchaseService();
    svc.execute.mockResolvedValue({
      success: true,
      purchase: {
        domain: 'example.com',
        registrar: 'test',
        priceEur: 10,
        renewalPriceEur: 10,
        purchasedAt: new Date().toISOString(),
      },
      message: 'Purchased!',
    });

    const app = express();
    app.use(express.json());
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/purchase/execute')
      .send({ domain: 'example.com', years: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.purchase.domain).toBe('example.com');
  });

  it('returns 400 when purchase fails', async () => {
    const svc = createMockPurchaseService();
    svc.execute.mockResolvedValue({ success: false, error: 'Domain taken' });

    const app = express();
    app.use(express.json());
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).post('/api/purchase/execute').send({ domain: 'example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Domain taken');
  });

  it('returns 400 with PURCHASE_NOT_APPROVED code', async () => {
    const svc = createMockPurchaseService();
    svc.execute.mockRejectedValue(new PurchaseNotApprovedError('example.com', 'test'));

    const app = express();
    app.use(express.json());
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).post('/api/purchase/execute').send({ domain: 'example.com' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PURCHASE_NOT_APPROVED');
  });

  it('validates request body', async () => {
    const svc = createMockPurchaseService();
    const app = express();
    app.use(express.json());
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).post('/api/purchase/execute').send({});

    expect(res.status).toBe(400);
  });
});

describe('GET /api/purchase/price', () => {
  it('returns prices for comma-separated domains', async () => {
    const svc = createMockPurchaseService();
    svc.checkPrice.mockResolvedValue([
      {
        domain: 'foo.com',
        available: true,
        registerPriceEur: 10,
        renewalPriceEur: 10,
        transferPriceEur: 10,
        checkedAt: new Date().toISOString(),
      },
      {
        domain: 'bar.io',
        available: false,
        registerPriceEur: null,
        renewalPriceEur: null,
        transferPriceEur: null,
        checkedAt: new Date().toISOString(),
      },
    ]);

    const app = express();
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/api/purchase/price?domains=foo.com,bar.io');
    expect(res.status).toBe(200);
    expect(res.body.prices).toHaveLength(2);
  });

  it('validates domains query param', async () => {
    const svc = createMockPurchaseService();
    const app = express();
    app.use('/api/purchase', createPurchaseRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/api/purchase/price');
    expect(res.status).toBe(400);
  });
});
