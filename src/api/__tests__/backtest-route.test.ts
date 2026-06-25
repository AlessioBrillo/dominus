import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { createBacktestRouter } from '../routes/backtest.js';
import { errorHandler } from '../middleware/error-handler.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('POST /api/v1/backtest', () => {
  let provider: SqliteProvider;
  let outcomeRepo: OutcomeRepository;

  beforeEach(() => {
    provider = openTestDb();
    outcomeRepo = new OutcomeRepository(provider);
  });

  it('snapshot returns scanned/inserted/skipped counters', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/backtest', createBacktestRouter(provider, outcomeRepo));
    app.use(errorHandler);

    const res = await request(app).post('/api/v1/backtest/snapshot');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('scanned');
    expect(res.body).toHaveProperty('inserted');
    expect(res.body).toHaveProperty('skipped');
    expect(typeof res.body.scanned).toBe('number');
  });

  it('report returns calibration metrics', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/backtest', createBacktestRouter(provider, outcomeRepo));
    app.use(errorHandler);

    const res = await request(app).post('/api/v1/backtest/report');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sampleSize');
    expect(res.body).toHaveProperty('meanAbsoluteErrorEur');
    expect(res.body).toHaveProperty('biasEur');
    expect(res.body).toHaveProperty('calibration');
  });

  it('suggest-weights returns weight suggestion report', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/backtest', createBacktestRouter(provider, outcomeRepo));
    app.use(errorHandler);

    const res = await request(app).post('/api/v1/backtest/suggest-weights');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sampleSize');
    expect(res.body).toHaveProperty('suggestions');
    expect(res.body).toHaveProperty('sumsToOne');
  });
});
