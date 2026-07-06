import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPublicRouter } from '../public-router.js';
import { MockDatabaseProvider } from '../../db/provider/mock-adapter.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { ScoreResult } from '../../types/score.js';
import type { AnonScoringService } from '../../services/anon-scoring-service.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';

function makeScoreResult(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    domain: 'example.com',
    expectedValue: 100,
    confidence: 0.65,
    suggestedBuyMax: 50,
    suggestedListPrice: 300,
    weightedScore: 0.567,
    recommended: true,
    breakdown: {
      intrinsic: { score: 0.8, weight: 0.3, details: {} },
      commercial: {
        score: 0.5,
        weight: 0.35,
        details: { monthlySearchVolume: 10000, cpc: 2.5, volumeScore: 0.01, cpcScore: 0.05 },
      },
      market: { score: 0.3, weight: 0.25, details: { comparables: 5, medianSalePrice: 2000 } },
      expiry: { score: 0, weight: 0.1, details: { isCloseout: false } },
    },
    scoredAt: new Date().toISOString(),
    signalStatus: [],
    bidRange: { conservative: 25, aggressive: 50 },
    effectiveWeights: { intrinsic: 0.3, commercial: 0.35, market: 0.25, expiry: 0.1 },
    effectiveRecommendThreshold: 0.4,
    effectiveConfidenceThreshold: 0.3,
    ...overrides,
  } as ScoreResult;
}

function makeStubEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue(makeScoreResult()),
    updateWeights: vi.fn(),
    updateTldBonuses: vi.fn(),
    get currentWeights() {
      return { intrinsic: 0.3, commercial: 0.35, market: 0.25, expiry: 0.1 };
    },
  } as unknown as ScoringEngine;
}

function makeStubGate(): TrademarkGate {
  return {
    check: vi.fn().mockResolvedValue({
      domain: 'example.com',
      verdict: GateVerdict.Clear,
      verifiedSources: ['USPTO', 'EUIPO'],
      partial: false,
      usptoFailed: false,
    }),
  } as unknown as TrademarkGate;
}

function makeStubAnonScoring(): AnonScoringService {
  return {
    score: vi.fn().mockResolvedValue({
      domain: 'example.com',
      score: makeScoreResult(),
      trademark: { verdict: 'clear', verifiedSources: ['USPTO'] },
      scoredAt: new Date().toISOString(),
    }),
    clearCache: vi.fn(),
  } as unknown as AnonScoringService;
}

function acceptJson(req: request.Test): request.Test {
  return req.set('Accept', 'application/json');
}

describe('Public Router — /public', () => {
  let db: MockDatabaseProvider;
  let engine: ScoringEngine;
  let gate: TrademarkGate;
  let anonScoring: AnonScoringService;

  beforeEach(() => {
    db = new MockDatabaseProvider();
    engine = makeStubEngine();
    gate = makeStubGate();
    anonScoring = makeStubAnonScoring();
  });

  describe('POST /public/scores', () => {
    it('returns 201 with slug when creating a public score', async () => {
      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(db, engine, gate));
      app.use(errorHandler);

      const res = await request(app).post('/public/scores').send({ domain: 'example.com' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('slug');
      expect(res.body).toHaveProperty('url');
      expect(res.body.url).toContain('/public/s/');
      expect(res.body.domain).toBe('example.com');
    });

    it('returns 400 for invalid domain', async () => {
      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(db, engine, gate));
      app.use(errorHandler);

      const res = await request(app).post('/public/scores').send({ domain: 'not-a-valid-domain' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DOMAIN');
    });

    it('returns 400 when domain is missing', async () => {
      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(db, engine, gate));
      app.use(errorHandler);

      const res = await request(app).post('/public/scores').send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DOMAIN');
    });

    it('stores trademark result when gate is provided', async () => {
      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(db, engine, gate));
      app.use(errorHandler);

      const res = await request(app).post('/public/scores').send({ domain: 'example.com' });

      expect(res.status).toBe(201);
      expect(gate.check).toHaveBeenCalledWith('example.com');
    });

    it('stores unverified trademark when gate errors', async () => {
      const failingGate = {
        check: vi.fn().mockRejectedValue(new Error('API down')),
      } as unknown as TrademarkGate;

      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(db, engine, failingGate));
      app.use(errorHandler);

      const res = await request(app).post('/public/scores').send({ domain: 'example.com' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('slug');
    });
  });

  describe('GET /public/domain/:domain (JSON)', () => {
    it('returns 200 with score for a valid domain', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/example.com'));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('domain', 'example.com');
      expect(res.body).toHaveProperty('score');
    });

    it('returns 400 for invalid domain', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/not-a-domain'));

      expect(res.status).toBe(400);
    });

    it('includes trademark data when gate is available', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/example.com'));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('trademark');
    });
  });

  describe('GET /public/domain/:domain (HTML)', () => {
    it('returns HTML when client accepts text/html', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  describe('GET /public/s/:slug', () => {
    it('returns 400 for slug shorter than 8 chars', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abc'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SLUG');
    });

    it('returns 404 for non-existent slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abcdef123456'));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /public/compare/:slug1/:slug2', () => {
    it('returns 400 when slugs are too short', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/compare/ab/abc'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SLUG');
    });

    it('returns 404 when one or both slugs not found', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/compare/abcdef123456/abcdef123457'));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /public/s/:slug/og.png', () => {
    it('returns 400 for short slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/ab/og.png'));

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abcdef123456/og.png'));

      expect(res.status).toBe(404);
    });
  });

  describe('GET /public/sitemap.xml', () => {
    it('returns 200 with valid XML', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await request(app).get('/public/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('xml');
    });
  });

  describe('CORS Headers', () => {
    it('sets Access-Control-Allow-Origin to *', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await request(app)
        .get('/public/sitemap.xml')
        .set('Origin', 'https://example.com');

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('allows OPTIONS preflight', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine));
      app.use(errorHandler);

      const res = await request(app)
        .options('/public/sitemap.xml')
        .set('Origin', 'https://example.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(res.status).toBe(204);
    });
  });

  describe('SEO Metadata in HTML responses', () => {
    it('includes robots meta tag', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('content="index,follow"');
    });

    it('includes canonical URL', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('rel="canonical"');
    });

    it('includes JSON-LD structured data', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('application/ld+json');
      expect(res.text).toContain('schema.org');
    });

    it('includes OG meta tags', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('og:title');
      expect(res.text).toContain('og:description');
      expect(res.text).toContain('og:type');
      expect(res.text).toContain('og:site_name');
    });

    it('includes Twitter card meta tags', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('twitter:card');
      expect(res.text).toContain('twitter:site');
    });

    it('includes JSON-LD alternate link for content negotiation', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('alternate');
      expect(res.text).toContain('application/json');
    });
  });

  describe('Rate Limiting', () => {
    it('applies rate limiting headers', async () => {
      const app = express();
      app.use('/public', createPublicRouter(db, engine, gate, anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/sitemap.xml');

      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });
  });
});
