// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPublicRouter } from '../public-router.js';
import { errorHandler } from '../middleware/error-handler.js';
import { renderScorePage, renderDomainPage, renderComparePage } from '../views/index.js';
import { generateOgPng } from '../open-graph.js';
import type { AnonScoringService } from '../../services/anon-scoring-service.js';
import type { ScoreResult } from '../../types/score.js';

beforeAll(async () => {
  // Pre-warm the native sharp module: the first dynamic import inside
  // generateOgPng can exceed the 5s default test timeout on a saturated
  // CI runner (and much more on Windows first load), so it must not run
  // inside a timed test. Hook timeout is 120s to survive cold native
  // loads in CI.
  await generateOgPng('warmup.example.com', {
    domain: 'warmup.example.com',
    expectedValue: 1,
    confidence: 0.5,
    weightedScore: 0.5,
    recommended: false,
    trademark: 'unverified',
  });
}, 120_000);

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

function makeStubAnonScoring(): AnonScoringService {
  return {
    score: vi.fn().mockResolvedValue({
      domain: 'example.com',
      score: makeScoreResult(),
      trademark: { verdict: 'clear', verifiedSources: ['USPTO'] },
      scoredAt: new Date().toISOString(),
    }),
    valuate: vi.fn().mockResolvedValue({
      domain: 'example.com',
      score: makeScoreResult(),
      trademark: { verdict: 'clear', verifiedSources: ['USPTO'] },
      scoredAt: new Date().toISOString(),
    }),
    createScore: vi.fn().mockResolvedValue({
      slug: 'abc123def456',
      url: '/public/s/abc123def456',
      domain: 'example.com',
    }),
    getScoreBySlug: vi.fn().mockImplementation((slug: string) => {
      if (slug === 'abc123def456') {
        return Promise.resolve({
          slug: 'abc123def456',
          domain: 'example.com',
          score: makeScoreResult(),
          trademark: { verdict: 'clear', verifiedSources: ['USPTO'] },
          viewCount: 5,
          createdAt: '2025-01-15T00:00:00.000Z',
        });
      }
      return Promise.resolve(null);
    }),
    getCompareScores: vi.fn().mockImplementation((slug1: string, slug2: string) => {
      if (slug1 === 'abc123def456' && slug2 === 'xyz789def456') {
        return Promise.resolve({
          score1: {
            domain: 'example.com',
            score: makeScoreResult(),
            trademark: { verdict: 'clear', verifiedSources: ['USPTO'] },
          },
          score2: {
            domain: 'test.org',
            score: makeScoreResult({ domain: 'test.org', expectedValue: 50 }),
            trademark: null,
          },
        });
      }
      if (
        (slug1 === 'abc123def456' && slug2 === 'missingScore') ||
        (slug2 === 'abc123def456' && slug1 === 'missingScore')
      ) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    }),
    bumpViewCount: vi.fn(),
    listRecentScores: vi
      .fn()
      .mockResolvedValue([{ slug: 's1', domain: 'a.com', created_at: '2025-01-15T00:00:00.000Z' }]),
    findForOgImage: vi.fn().mockImplementation((slug: string) => {
      if (slug === 'abc123def456') {
        return Promise.resolve({
          slug: 'abc123def456',
          domain: 'example.com',
          score_json: JSON.stringify(makeScoreResult()),
          trademark_json: JSON.stringify({ verdict: 'clear', verifiedSources: ['USPTO'] }),
        });
      }
      return Promise.resolve(null);
    }),
    clearCache: vi.fn(),
  } as unknown as AnonScoringService;
}

function acceptJson(req: request.Test): request.Test {
  return req.set('Accept', 'application/json');
}

describe('Public Router — /public', () => {
  let anonScoring: AnonScoringService;

  beforeEach(() => {
    anonScoring = makeStubAnonScoring();
  });

  describe('POST /public/scores', () => {
    it('returns 201 with slug when creating a public score', async () => {
      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(anonScoring));
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
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).post('/public/scores').send({ domain: 'not-a-valid-domain' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DOMAIN');
    });

    it('returns 400 when domain is missing', async () => {
      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).post('/public/scores').send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DOMAIN');
    });

    it('calls createScore on the service', async () => {
      const app = express();
      app.use(express.json());
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      await request(app).post('/public/scores').send({ domain: 'example.com' });

      expect(anonScoring.createScore).toHaveBeenCalledWith('example.com');
    });
  });

  describe('GET /public/domain/:domain (JSON)', () => {
    it('returns 200 with score for a valid domain', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/example.com'));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('domain', 'example.com');
      expect(res.body).toHaveProperty('score');
    });

    it('returns 400 for invalid domain', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/not-a-domain'));

      expect(res.status).toBe(400);
    });

    it('includes trademark data in result', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/example.com'));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('trademark');
      expect(res.body.trademark.verdict).toBe('clear');
    });

    it('omits suggestedBuyMax from the score when trademark is not verified', async () => {
      anonScoring = makeStubAnonScoring();
      const score = makeScoreResult();
      const { suggestedBuyMax: _unused, ...scoreWithoutBuyMax } = score;
      vi.mocked(anonScoring.valuate).mockResolvedValue({
        domain: 'example.com',
        score: scoreWithoutBuyMax,
        trademark: { verdict: 'unverified', verifiedSources: [] },
        scoredAt: new Date().toISOString(),
      });

      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/example.com'));

      expect(res.status).toBe(200);
      expect(res.body.trademark.verdict).toBe('unverified');
      expect(res.body.score.suggestedBuyMax).toBeUndefined();
    });

    it('includes suggestedBuyMax in the score when trademark is verified', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/example.com'));

      expect(res.status).toBe(200);
      expect(res.body.trademark.verdict).toBe('clear');
      expect(res.body.score.suggestedBuyMax).toBe(50);
    });

    it('sets a Cache-Control header on JSON responses (CDN-cacheable)', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/domain/example.com'));

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('max-age');
    });
  });

  describe('GET /public/domain/:domain (HTML)', () => {
    it('returns HTML when client accepts text/html', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('hides the buy-max stat in HTML when trademark is not verified', async () => {
      anonScoring = makeStubAnonScoring();
      const score = makeScoreResult();
      const { suggestedBuyMax: _unused, ...scoreWithoutBuyMax } = score;
      vi.mocked(anonScoring.valuate).mockResolvedValue({
        domain: 'example.com',
        score: scoreWithoutBuyMax,
        trademark: { verdict: 'unverified', verifiedSources: [] },
        scoredAt: new Date().toISOString(),
      });

      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Suggested Buy Max');
    });

    it('shows the buy-max stat in HTML when trademark is verified', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.text).toContain('Suggested Buy Max');
    });
  });

  describe('GET /public/s/:slug', () => {
    it('returns 400 for slug shorter than 8 chars', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abc'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SLUG');
    });

    it('returns 404 for non-existent slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abcdef123456'));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 200 with score data for existing slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abc123def456'));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('slug', 'abc123def456');
      expect(res.body).toHaveProperty('domain', 'example.com');
      expect(res.body).toHaveProperty('score');
      expect(res.body).toHaveProperty('viewCount');
      expect(res.body.viewCount).toBe(6);
      expect(res.body.trademark).not.toBeNull();
    });

    it('bumps view count on access', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      await acceptJson(request(app).get('/public/s/abc123def456'));

      expect(anonScoring.bumpViewCount).toHaveBeenCalledWith('abc123def456');
    });

    it('hides the buy-max stat in HTML when trademark is not clear (defense-in-depth)', async () => {
      anonScoring = makeStubAnonScoring();
      vi.mocked(anonScoring.getScoreBySlug).mockResolvedValue({
        slug: 'abc123def456',
        domain: 'example.com',
        score: makeScoreResult(),
        trademark: { verdict: 'unverified', verifiedSources: [] },
        viewCount: 5,
        createdAt: '2025-01-15T00:00:00.000Z',
      });

      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/s/abc123def456').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Suggested Buy Max');
      expect(res.text).not.toContain('"@type":"Offer"');
    });

    it('omits suggestedBuyMax from JSON when trademark is not clear (defense-in-depth)', async () => {
      anonScoring = makeStubAnonScoring();
      vi.mocked(anonScoring.getScoreBySlug).mockResolvedValue({
        slug: 'abc123def456',
        domain: 'example.com',
        score: makeScoreResult(),
        trademark: { verdict: 'blocked', verifiedSources: ['USPTO'] },
        viewCount: 5,
        createdAt: '2025-01-15T00:00:00.000Z',
      });

      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abc123def456'));

      expect(res.status).toBe(200);
      expect(res.body.trademark.verdict).toBe('blocked');
      expect(res.body.score.suggestedBuyMax).toBeUndefined();
      expect(res.body.score.expectedValue).toBe(100);
    });

    it('shows the buy-max stat in HTML when trademark is clear', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/s/abc123def456').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.text).toContain('Suggested Buy Max');
    });
  });

  describe('GET /public/compare/:slug1/:slug2', () => {
    it('returns 400 when slugs are too short', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/compare/ab/abc'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SLUG');
    });

    it('returns 404 when one or both slugs not found', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/compare/abc123def456/missingScore'));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 200 with both scores when found', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/compare/abc123def456/xyz789def456'));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('score1');
      expect(res.body).toHaveProperty('score2');
      expect(res.body.score1.domain).toBe('example.com');
      expect(res.body.score2.domain).toBe('test.org');
    });

    it('omits suggestedBuyMax from JSON per-score when trademark is not clear', async () => {
      anonScoring = makeStubAnonScoring();
      vi.mocked(anonScoring.getCompareScores).mockResolvedValue({
        score1: {
          domain: 'example.com',
          score: makeScoreResult(),
          trademark: { verdict: 'clear', verifiedSources: ['USPTO'] },
        },
        score2: {
          domain: 'test.org',
          score: makeScoreResult({ domain: 'test.org', expectedValue: 50 }),
          trademark: { verdict: 'unverified', verifiedSources: [] },
        },
      });

      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/compare/abc123def456/xyz789def456'));

      expect(res.status).toBe(200);
      expect(res.body.score1.score.suggestedBuyMax).toBe(50);
      expect(res.body.score2.score.suggestedBuyMax).toBeUndefined();
    });
  });

  describe('GET /public/s/:slug/og.png', () => {
    it('returns 400 for short slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/ab/og.png'));

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await acceptJson(request(app).get('/public/s/abcdef123456/og.png'));

      expect(res.status).toBe(404);
    });

    it('returns 200 with PNG for existing slug', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/s/abc123def456/og.png');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
    });
  });

  describe('GET /public/sitemap.xml', () => {
    it('returns 200 with valid XML', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('xml');
    });

    it('caches the sitemap in-memory within TTL (single DB query)', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      await request(app).get('/public/sitemap.xml').set('Host', 'example.com');
      await request(app).get('/public/sitemap.xml').set('Host', 'example.com');

      expect(anonScoring.listRecentScores).toHaveBeenCalledTimes(1);
    });

    it('serves 304 when If-None-Match matches the ETag', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const first = await request(app).get('/public/sitemap.xml').set('Host', 'example.com');
      expect(first.status).toBe(200);
      expect(first.headers['etag']).toBeDefined();

      const second = await request(app)
        .get('/public/sitemap.xml')
        .set('Host', 'example.com')
        .set('If-None-Match', String(first.headers['etag']));

      expect(second.status).toBe(304);
    });
  });

  describe('CORS Headers', () => {
    it('does not set CORS headers directly (handled by global middleware)', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app)
        .get('/public/sitemap.xml')
        .set('Origin', 'https://example.com');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Structured Data (JSON-LD) in rendered views', () => {
    it('renderScorePage includes Product + Review + AggregateRating + BreadcrumbList + Organization', () => {
      const data = {
        slug: 'abcdef123456',
        domain: 'example.com',
        score: {
          expectedValue: 100,
          confidence: 0.65,
          suggestedBuyMax: 50,
          suggestedListPrice: 300,
          weightedScore: 0.567,
          recommended: true,
          scoredAt: '2025-01-15T00:00:00.000Z',
        },
        trademark: { verdict: 'clear', verifiedSources: ['USPTO', 'EUIPO'] },
        viewCount: 10,
        createdAt: '2025-01-15T00:00:00.000Z',
      };

      const html = renderScorePage(data, 'https://dominus.app');
      expect(html).toContain('application/ld+json');
      expect(html).toContain('"@type":"Product"');
      expect(html).toContain('"@type":"Review"');
      expect(html).toContain('"@type":"Rating"');
      expect(html).toContain('"@type":"BreadcrumbList"');
      expect(html).toContain('"@type":"Organization"');
      expect(html).toContain('example.com');
    });

    it('renderDomainPage includes Product + AggregateRating + Organization (not Review)', () => {
      const html = renderDomainPage(
        'example.com',
        {
          expectedValue: 100,
          confidence: 0.65,
          suggestedBuyMax: 50,
          suggestedListPrice: 300,
          weightedScore: 0.567,
          recommended: true,
          scoredAt: '2025-01-15T00:00:00.000Z',
        },
        { verdict: 'clear', verifiedSources: ['USPTO', 'EUIPO'] },
        'https://dominus.app',
      );

      expect(html).toContain('application/ld+json');
      expect(html).toContain('"@type":"Product"');
      expect(html).toContain('"@type":"AggregateRating"');
      expect(html).toContain('"@type":"Organization"');
      expect(html).not.toContain('"@type":"Review"');
    });

    it('renderDomainPage aggregateRating uses confidence-based value (not weightedScore/10 bug)', () => {
      const html = renderDomainPage(
        'example.com',
        {
          expectedValue: 100,
          confidence: 0.65,
          suggestedBuyMax: 50,
          suggestedListPrice: 300,
          weightedScore: 0.567,
          recommended: true,
          scoredAt: '2025-01-15T00:00:00.000Z',
        },
        undefined,
        'https://dominus.app',
      );
      expect(html).toContain('"ratingValue":65');
      expect(html).not.toContain('"ratingValue":0');
    });

    it('renderComparePage includes ItemList + Product + Organization + both domains', () => {
      const makeScore = (
        domain: string,
        ev: number,
        conf: number,
      ): {
        domain: string;
        score: {
          expectedValue: number;
          confidence: number;
          suggestedBuyMax: number;
          weightedScore: number;
          recommended: boolean;
          scoredAt: string;
        };
        trademark: null;
      } => ({
        domain,
        score: {
          expectedValue: ev,
          confidence: conf,
          suggestedBuyMax: Math.round(ev * conf),
          weightedScore: conf * 0.8,
          recommended: conf > 0.5,
          scoredAt: '2025-01-15T00:00:00.000Z',
        },
        trademark: null,
      });

      const html = renderComparePage(
        'example.com',
        makeScore('example.com', 100, 0.65),
        'testdomain.io',
        makeScore('testdomain.io', 200, 0.45),
        'https://dominus.app',
      );

      expect(html).toContain('application/ld+json');
      expect(html).toContain('"@type":"ItemList"');
      expect(html).toContain('"@type":"Product"');
      expect(html).toContain('"@type":"Organization"');
      expect(html).toContain('example.com');
      expect(html).toContain('testdomain.io');
    });

    it('sitemap includes image namespace declaration', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.text).toContain('xmlns:image');
    });

    it('score HTML via HTTP includes Link preload header for OG image', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/s/abc123def456').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.headers['link']).toContain('rel=preload');
      expect(res.headers['link']).toContain('og.png');
    });
  });

  describe('SEO Metadata in HTML responses', () => {
    it('includes robots meta tag', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('content="index,follow"');
    });

    it('includes canonical URL', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('rel="canonical"');
    });

    it('includes JSON-LD structured data', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('application/ld+json');
      expect(res.text).toContain('schema.org');
    });

    it('includes OG meta tags', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('og:title');
      expect(res.text).toContain('og:description');
      expect(res.text).toContain('og:type');
      expect(res.text).toContain('og:site_name');
    });

    it('includes Twitter card meta tags', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('twitter:card');
      expect(res.text).toContain('twitter:site');
    });

    it('includes JSON-LD alternate link for content negotiation', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/domain/example.com').set('Accept', 'text/html');

      expect(res.text).toContain('alternate');
      expect(res.text).toContain('application/json');
    });
  });

  describe('Site URL resolution (canonical/OG/robots)', () => {
    it('uses the configured PUBLIC_APP_URL for og:image, og:url, JSON-LD and footer', async () => {
      const app = express();
      app.use(
        '/public',
        createPublicRouter(anonScoring, undefined, { publicAppUrl: 'https://app.example.com' }),
      );
      app.use(errorHandler);

      const res = await request(app).get('/public/s/abc123def456').set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.text).toContain('https://app.example.com/public/s/abc123def456/og.png');
      expect(res.text).toContain(
        'property="og:url" content="https://app.example.com/public/s/abc123def456"',
      );
      expect(res.text).toContain('"url":"https://app.example.com"');
      expect(res.text).toContain('href="https://app.example.com"');
      expect(res.text).not.toContain('dominus.app');
    });

    it('falls back to the request origin when PUBLIC_APP_URL is unset (self-hosted)', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app)
        .get('/public/s/abc123def456')
        .set('Accept', 'text/html')
        .set('Host', 'selfhost.example.com');

      expect(res.status).toBe(200);
      expect(res.text).toContain('selfhost.example.com/public/s/abc123def456/og.png');
      expect(res.text).toContain(
        'property="og:url" content="http://selfhost.example.com/public/s/abc123def456"',
      );
    });

    it('uses the configured URL for the sitemap origin', async () => {
      const app = express();
      app.use(
        '/public',
        createPublicRouter(anonScoring, undefined, { publicAppUrl: 'https://app.example.com' }),
      );
      app.use(errorHandler);

      const res = await request(app).get('/public/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.text).toContain('<loc>https://app.example.com/public/s/');
    });

    it('serves robots.txt with the configured sitemap URL', async () => {
      const app = express();
      app.use(
        '/public',
        createPublicRouter(anonScoring, undefined, { publicAppUrl: 'https://app.example.com' }),
      );
      app.use(errorHandler);

      const res = await request(app).get('/public/robots.txt');

      expect(res.status).toBe(200);
      expect(res.text).toContain('User-agent: *');
      expect(res.text).toContain('Sitemap: https://app.example.com/public/sitemap.xml');
      expect(res.headers['cache-control']).toContain('public');
    });

    it('robots.txt Sitemap falls back to the request origin', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/robots.txt').set('Host', 'selfhost.example.com');

      expect(res.text).toContain('Sitemap: http://selfhost.example.com/public/sitemap.xml');
    });

    it('renderDomainPage footer and Organization JSON-LD use the configured site URL', () => {
      const html = renderDomainPage(
        'example.com',
        makeScoreResult(),
        { verdict: 'clear', verifiedSources: ['USPTO'] },
        'https://custom.app',
      );
      expect(html).toContain('href="https://custom.app"');
      expect(html).toContain('"url":"https://custom.app"');
      expect(html).not.toContain('dominus.app');
    });
  });

  describe('Rate Limiting', () => {
    it('applies rate limiting headers', async () => {
      const app = express();
      app.use('/public', createPublicRouter(anonScoring));
      app.use(errorHandler);

      const res = await request(app).get('/public/sitemap.xml');

      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });
  });
});
