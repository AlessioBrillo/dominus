import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrator.js';
import { PortfolioRepository } from '../../../db/repositories/portfolio-repository.js';
import { OutcomeRepository } from '../../../db/repositories/outcome-repository.js';
import { PnlService } from '../../../portfolio/pnl-service.js';
import { createAnalyticsRouter } from '../analytics.js';
import type { PredictionAccuracyAnalyzer } from '../../../analytics/index.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeAccuracyStub(): PredictionAccuracyAnalyzer {
  return {
    refresh: vi
      .fn()
      .mockReturnValue({ scanned: 0, included: 0, skippedNoScore: 0, skippedNoOutcome: 0 }),
    generate: vi.fn().mockReturnValue({
      generatedAt: new Date().toISOString(),
      sampleSize: 0,
      overall: { mape: 0, medianApe: 0, mae: 0, rmse: 0, bias: 0, biasPct: 0, sampleSize: 0 },
      confusionMatrix: {
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 0,
        falseNegatives: 0,
        precision: 0,
        recall: 0,
        f1: 0,
      },
      byTld: [],
      calibration: {
        low: { n: 0, meanAbsError: 0, meanRealised: 0, meanPredicted: 0 },
        mid: { n: 0, meanAbsError: 0, meanRealised: 0, meanPredicted: 0 },
        high: { n: 0, meanAbsError: 0, meanRealised: 0, meanPredicted: 0 },
      },
      bySignalAvailability: [],
      trend: [],
      warnings: [],
    }),
    findScoringRunBefore: vi.fn().mockReturnValue(null),
  } as unknown as PredictionAccuracyAnalyzer;
}

function buildApp(pnlService?: PnlService): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/analytics', createAnalyticsRouter(makeAccuracyStub(), pnlService));
  app.use((_req, res) =>
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );
  return app;
}

describe('Analytics API routes', () => {
  let db: Database.Database;
  let portfolioRepo: PortfolioRepository;

  beforeEach(() => {
    db = openTestDb();
    portfolioRepo = new PortfolioRepository(db);
  });

  it('GET /api/v1/analytics/accuracy returns accuracy report', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/analytics/accuracy');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sampleSize');
    expect(res.body).toHaveProperty('overall');
    expect(res.body).toHaveProperty('confusionMatrix');
  });

  it('POST /api/v1/analytics/refresh triggers refresh', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/analytics/refresh');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('scanned');
  });

  it('GET /api/v1/analytics/pnl returns P&L report when PnlService is provided', async () => {
    const outcomeRepo = new OutcomeRepository(db);
    const pnlService = new PnlService(portfolioRepo, outcomeRepo.findAll());
    const app = buildApp(pnlService);
    const res = await request(app).get('/api/v1/analytics/pnl');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('perDomain');
    expect(res.body).toHaveProperty('monthlyTrend');
    expect(res.body.summary.totalInvestmentEur).toBe(0);
  });

  it('GET /api/v1/analytics/pnl returns P&L with portfolio data', async () => {
    const outcomeRepo = new OutcomeRepository(db);

    portfolioRepo.insert({
      domain: 'test.com',
      tld: 'com',
      acquiredAt: new Date().toISOString(),
      renewalDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      acquisitionCost: 15,
      renewalCost: 9.5,
      registrar: 'manual',
      notes: undefined,
    });

    outcomeRepo.insert({
      domain: 'test.com',
      type: 'sold',
      occurredAt: new Date().toISOString(),
      salePriceEur: 200,
      notes: undefined,
    });

    const pnlService = new PnlService(portfolioRepo, outcomeRepo.findAll());
    const app = buildApp(pnlService);
    const res = await request(app).get('/api/v1/analytics/pnl');
    expect(res.status).toBe(200);
    expect(res.body.summary.totalInvestmentEur).toBe(15);
    expect(res.body.summary.totalReturnsEur).toBe(200);
    expect(res.body.perDomain).toHaveLength(1);
    expect(res.body.perDomain[0].domain).toBe('test.com');
  });

  it('GET /api/v1/analytics/pnl returns 404 when PnlService is not provided', async () => {
    const app = buildApp();
    // When pnlService is undefined, the route does not register
    const res = await request(app).get('/api/v1/analytics/pnl');
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/analytics/pnl handles PnlService errors gracefully', async () => {
    const brokenService = {
      generate: vi.fn().mockImplementation(() => {
        throw new Error('DB connection failed');
      }),
    } as unknown as PnlService;
    const app = buildApp(brokenService);
    const res = await request(app).get('/api/v1/analytics/pnl');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PNL_ERROR');
  });
});
