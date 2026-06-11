import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createScoreRouter } from '../routes/score.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { ScoreResult } from '../../types/score.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';

function makeScoreResult(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    domain: 'test.com',
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
    ...overrides,
  };
}

function makeStubEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue(makeScoreResult()),
  } as unknown as ScoringEngine;
}

function makeStubGate(): TrademarkGate {
  return {
    check: vi.fn().mockResolvedValue({
      domain: 'test.com',
      verdict: GateVerdict.Clear,
      verifiedSources: ['USPTO', 'EUIPO'],
      partial: false,
      usptoFailed: false,
    }),
  } as unknown as TrademarkGate;
}

describe('GET /api/score/:domain', () => {
  it('returns 200 with score result for a valid domain', async () => {
    const app = express();
    app.use('/api/score', createScoreRouter(makeStubEngine()));
    app.use(errorHandler);

    const res = await request(app).get('/api/score/example.com');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('domain', 'example.com');
    expect(res.body).toHaveProperty('score');
    expect(res.body.score).toHaveProperty('expectedValue');
    expect(res.body.score).toHaveProperty('confidence');
    expect(res.body.score).toHaveProperty('recommended');
  });

  it('returns 400 for an invalid domain', async () => {
    const app = express();
    app.use('/api/score', createScoreRouter(makeStubEngine()));
    app.use(errorHandler);

    const res = await request(app).get('/api/score/not-a-domain');
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'INVALID_DOMAIN');
  });

  it('passes closeout query params to the engine', async () => {
    const engine = makeStubEngine();
    const app = express();
    app.use('/api/score', createScoreRouter(engine));
    app.use(errorHandler);

    await request(app).get('/api/score/expired.com?closeout=true&age=5&backlinks=100&wayback=200');
    expect(engine.score).toHaveBeenCalledWith(
      expect.objectContaining({
        isCloseout: true,
        domainAge: 5,
        backlinks: 100,
        waybackSnapshots: 200,
      }),
    );
  });

  it('includes trademark gate result when gate is provided', async () => {
    const gate = makeStubGate();
    const app = express();
    app.use('/api/score', createScoreRouter(makeStubEngine(), gate));
    app.use(errorHandler);

    const res = await request(app).get('/api/score/example.com');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('trademark');
    expect(res.body.trademark).toHaveProperty('verdict', 'clear');
    expect(res.body.trademark).toHaveProperty('verifiedSources');
  });

  it('returns unverified trademark when gate errors', async () => {
    const gate = {
      check: vi.fn().mockRejectedValue(new Error('Service unavailable')),
    } as unknown as TrademarkGate;
    const app = express();
    app.use('/api/score', createScoreRouter(makeStubEngine(), gate));
    app.use(errorHandler);

    const res = await request(app).get('/api/score/example.com');
    expect(res.status).toBe(200);
    expect(res.body.trademark).toHaveProperty('verdict', 'unverified');
  });
});
