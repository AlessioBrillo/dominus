// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import { createOnboardingRouter } from '../onboarding.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { GateVerdict } from '../../../trademark/trademark-gate.js';
import type { DatabaseProvider } from '../../../db/provider/interface.js';
import type { ScoringEngine } from '../../../scoring/scoring-engine.js';
import type { PortfolioManager } from '../../../portfolio/portfolio-manager.js';
import type { TrademarkGate } from '../../../trademark/trademark-gate.js';

function makeScoreResult(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    domain: 'vintagecoffee.com',
    expectedValue: 1200,
    confidence: 0.6,
    suggestedBuyMax: 350,
    suggestedListPrice: 1800,
    weightedScore: 0.72,
    recommended: true,
    ...overrides,
  };
}

function makeDb(): DatabaseProvider {
  return {
    dialect: 'sqlite',
    exec: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 1 }),
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    transaction: vi.fn(async <T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T> =>
      fn(makeDb()),
    ),
    close: vi.fn().mockResolvedValue(undefined),
    isOpen: vi.fn().mockReturnValue(true),
    backup: vi.fn(),
    runMigrations: vi.fn(),
    tryLock: vi.fn().mockResolvedValue(true),
    renewLock: vi.fn().mockResolvedValue(true),
    unlock: vi.fn().mockResolvedValue(undefined),
    tryLockWithFence: vi.fn().mockResolvedValue({ acquired: true, fenceToken: 'mock-fence-token' }),
    renewLockWithFence: vi.fn().mockResolvedValue(true),
    unlockWithFence: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseProvider;
}

function makeEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue(makeScoreResult()),
  } as unknown as ScoringEngine;
}

function makePortfolioManager(): PortfolioManager {
  return {
    add: vi.fn().mockResolvedValue({ domain: 'oldmaproom.net', verdict: 'keep' }),
  } as unknown as PortfolioManager;
}

function makeTrademarkGate(): TrademarkGate {
  return {
    check: vi.fn().mockResolvedValue({
      domain: 'vintagecoffee.com',
      verdict: GateVerdict.Clear,
      verifiedSources: ['uspto'],
    }),
  } as unknown as TrademarkGate;
}

function buildApp(
  overrides: {
    db?: DatabaseProvider;
    engine?: ScoringEngine;
    trademarkGate?: TrademarkGate | undefined;
    portfolioManager?: PortfolioManager;
  } = {},
): Application {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/onboarding',
    createOnboardingRouter(
      overrides.db ?? makeDb(),
      overrides.engine ?? makeEngine(),
      overrides.trademarkGate === undefined ? undefined : overrides.trademarkGate,
      overrides.portfolioManager ?? makePortfolioManager(),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe('API: /api/v1/onboarding', () => {
  describe('POST /sample-run', () => {
    it('scores all sample domains and returns results', async () => {
      const res = await request(buildApp()).post('/api/v1/onboarding/sample-run');
      expect(res.status).toBe(200);
      expect(res.body.sampleCount).toBe(3);
      expect(res.body.results).toHaveLength(3);
      expect(res.body.results[0].domain).toBe('vintagecoffee.com');
      expect(res.body.results[0].score.recommended).toBe(true);
    });

    it('includes trademark verdict when the gate is configured', async () => {
      const res = await request(buildApp({ trademarkGate: makeTrademarkGate() })).post(
        '/api/v1/onboarding/sample-run',
      );
      expect(res.status).toBe(200);
      expect(res.body.results[0].trademark.verdict).toBe('clear');
    });

    it('falls back to unverified when the trademark gate errors', async () => {
      const gate = makeTrademarkGate();
      (gate.check as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gate down'));
      const res = await request(buildApp({ trademarkGate: gate })).post(
        '/api/v1/onboarding/sample-run',
      );
      expect(res.status).toBe(200);
      expect(res.body.results[0].trademark.verdict).toBe('unverified');
    });

    it('records a sample_run_viewed event', async () => {
      const db = makeDb();
      await request(buildApp({ db })).post('/api/v1/onboarding/sample-run');
      expect(db.exec).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), [
        'default',
        'sample_run_viewed',
        expect.any(String),
      ]);
    });

    it('propagates scoring failures to the error handler', async () => {
      const engine = makeEngine();
      (engine.score as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('engine exploded'));
      const res = await request(buildApp({ engine })).post('/api/v1/onboarding/sample-run');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /portfolio/import', () => {
    const validPayload = {
      domains: [
        {
          domain: 'vintagecoffee.com',
          tld: '.com',
          acquiredAt: '2024-01-01',
          renewalDate: '2027-01-01',
          acquisitionCost: 50,
          renewalCost: 10,
          registrar: 'namecheap',
        },
      ],
    };

    it('imports domains and returns verdict summary', async () => {
      const res = await request(buildApp())
        .post('/api/v1/onboarding/portfolio/import')
        .send(validPayload);
      expect(res.status).toBe(201);
      expect(res.body.imported).toBe(1);
      expect(res.body.summary.keep).toBe(1);
      expect(res.body.summary.drop).toBe(0);
      expect(res.body.verdicts[0].trademarkClear).toBe(true);
      expect(res.body.verdicts[0].suggestedBuyMax).toBe(350);
    });

    it('returns 400 for an invalid payload', async () => {
      const res = await request(buildApp())
        .post('/api/v1/onboarding/portfolio/import')
        .send({ domains: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('reports invalid domains as errors without failing the batch', async () => {
      const res = await request(buildApp())
        .post('/api/v1/onboarding/portfolio/import')
        .send({ domains: [{ ...validPayload.domains[0], domain: 'not a domain' }] });
      expect(res.status).toBe(201);
      expect(res.body.imported).toBe(0);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].error).toBe('Invalid domain format');
    });

    it('treats a failing trademark gate as not trademark-clear', async () => {
      const gate = makeTrademarkGate();
      (gate.check as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gate down'));
      const res = await request(buildApp({ trademarkGate: gate }))
        .post('/api/v1/onboarding/portfolio/import')
        .send(validPayload);
      expect(res.status).toBe(201);
      expect(res.body.verdicts[0].trademarkClear).toBe(false);
    });

    it('keeps per-domain failures in the errors list', async () => {
      const engine = makeEngine();
      (engine.score as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('score failed'));
      const res = await request(buildApp({ engine }))
        .post('/api/v1/onboarding/portfolio/import')
        .send(validPayload);
      expect(res.status).toBe(201);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].error).toBe('score failed');
    });

    it('counts drop and reprice verdicts with annual savings', async () => {
      const pm = makePortfolioManager();
      (pm.add as ReturnType<typeof vi.fn>).mockResolvedValue({ domain: 'x.com', verdict: 'drop' });
      const engine = makeEngine();
      (engine.score as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeScoreResult({ recommended: false }),
      );
      const res = await request(buildApp({ portfolioManager: pm, engine }))
        .post('/api/v1/onboarding/portfolio/import')
        .send({ domains: [validPayload.domains[0]] });
      expect(res.status).toBe(201);
      expect(res.body.summary.drop).toBe(1);
      expect(res.body.summary.annualSavingsEur).toBe(10);
    });
  });

  describe('GET /state', () => {
    it('returns the welcome step when no state exists', async () => {
      const res = await request(buildApp()).get('/api/v1/onboarding/state');
      expect(res.status).toBe(200);
      expect(res.body.currentStep).toBe('welcome');
    });

    it('returns the stored state', async () => {
      const db = makeDb();
      (db.queryOne as ReturnType<typeof vi.fn>).mockResolvedValue({
        current_step: 'keywords',
        step_data: JSON.stringify({ keyword: 'coffee' }),
        completed_at: null,
      });
      const res = await request(buildApp({ db })).get('/api/v1/onboarding/state');
      expect(res.status).toBe(200);
      expect(res.body.currentStep).toBe('keywords');
      expect(res.body.stepData).toEqual({ keyword: 'coffee' });
    });
  });

  describe('PATCH /state', () => {
    it('saves the wizard state', async () => {
      const res = await request(buildApp())
        .patch('/api/v1/onboarding/state')
        .send({ currentStep: 'keywords', stepData: { keyword: 'coffee' } });
      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(true);
    });

    it('returns 400 for an invalid payload', async () => {
      const res = await request(buildApp()).patch('/api/v1/onboarding/state').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('marks onboarding as complete and records the event', async () => {
      const db = makeDb();
      const res = await request(buildApp({ db }))
        .patch('/api/v1/onboarding/state')
        .send({ currentStep: 'complete' });
      expect(res.status).toBe(200);
      expect(db.exec).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE onboarding_state SET completed_at'),
        ['default'],
      );
      expect(db.exec).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'), [
        'default',
        'onboarding_completed',
        expect.any(String),
      ]);
    });
  });
});
