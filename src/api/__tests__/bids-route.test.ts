import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBidsRouter } from '../routes/bids.js';
import { errorHandler } from '../middleware/error-handler.js';
import { BidStatus } from '../../types/acquisition.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockAcquisitionService(): any {
  return {
    place: vi.fn(),
    resolve: vi.fn(),
    list: vi.fn(),
    pending: vi.fn(),
    get: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeBid(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    domain: 'example.com',
    venue: 'sedo',
    bidAmountEur: 100,
    maxBidEur: undefined,
    status: BidStatus.Pending,
    bidPlacedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('POST /bids/place', () => {
  it('places a bid and returns 201', async () => {
    const svc = createMockAcquisitionService();
    svc.place.mockResolvedValue(makeBid());

    const app = express();
    app.use(express.json());
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app)
      .post('/bids/place')
      .send({ domain: 'example.com', venue: 'sedo', bidAmountEur: 100 });

    expect(res.status).toBe(201);
    expect(res.body.bid.domain).toBe('example.com');
  });

  it('returns 409 when duplicate pending bid exists', async () => {
    const svc = createMockAcquisitionService();
    svc.place.mockRejectedValue(new Error('already has a pending bid'));

    const app = express();
    app.use(express.json());
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app)
      .post('/bids/place')
      .send({ domain: 'example.com', venue: 'sedo', bidAmountEur: 100 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BID_CONFLICT');
  });

  it('validates required fields', async () => {
    const svc = createMockAcquisitionService();
    const app = express();
    app.use(express.json());
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app).post('/bids/place').send({ domain: 'example.com' });

    expect(res.status).toBe(400);
  });

  it('validates positive bid amount', async () => {
    const svc = createMockAcquisitionService();
    const app = express();
    app.use(express.json());
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app)
      .post('/bids/place')
      .send({ domain: 'example.com', bidAmountEur: -10 });

    expect(res.status).toBe(400);
  });
});

describe('POST /bids/resolve', () => {
  it('resolves a bid and returns 200', async () => {
    const svc = createMockAcquisitionService();
    svc.resolve.mockResolvedValue(makeBid({ status: BidStatus.Won }));

    const app = express();
    app.use(express.json());
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app)
      .post('/bids/resolve')
      .send({ domain: 'example.com', status: 'won' });

    expect(res.status).toBe(200);
    expect(res.body.bid.status).toBe('won');
  });

  it('returns 409 when resolve fails', async () => {
    const svc = createMockAcquisitionService();
    svc.resolve.mockRejectedValue(new Error('No bid found for domain'));

    const app = express();
    app.use(express.json());
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app)
      .post('/bids/resolve')
      .send({ domain: 'unknown.com', status: 'lost' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BID_RESOLVE_ERROR');
  });

  it('validates required fields', async () => {
    const svc = createMockAcquisitionService();
    const app = express();
    app.use(express.json());
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app).post('/bids/resolve').send({});

    expect(res.status).toBe(400);
  });
});

describe('GET /bids', () => {
  it('returns all bids', async () => {
    const svc = createMockAcquisitionService();
    svc.list.mockResolvedValue([makeBid(), makeBid({ domain: 'test.io' })]);

    const app = express();
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/bids');
    expect(res.status).toBe(200);
    expect(res.body.bids).toHaveLength(2);
  });

  it('filters by status query param', async () => {
    const svc = createMockAcquisitionService();
    svc.list.mockResolvedValue([makeBid()]);

    const app = express();
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/bids?status=pending');
    expect(res.status).toBe(200);
    expect(svc.list).toHaveBeenCalledWith('pending');
  });
});

describe('GET /bids/pending', () => {
  it('returns pending bids', async () => {
    const svc = createMockAcquisitionService();
    svc.pending.mockResolvedValue([makeBid()]);

    const app = express();
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/bids/pending');
    expect(res.status).toBe(200);
    expect(res.body.bids).toHaveLength(1);
  });
});

describe('GET /bids/:domain', () => {
  it('returns bid for the domain', async () => {
    const svc = createMockAcquisitionService();
    svc.get.mockResolvedValue(makeBid());

    const app = express();
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/bids/example.com');
    expect(res.status).toBe(200);
    expect(res.body.bid.domain).toBe('example.com');
  });

  it('returns 404 when no bid exists', async () => {
    const svc = createMockAcquisitionService();
    svc.get.mockResolvedValue(null);

    const app = express();
    app.use('/bids', createBidsRouter(svc));
    app.use(errorHandler);

    const res = await request(app).get('/bids/unknown.com');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BID_NOT_FOUND');
  });
});
