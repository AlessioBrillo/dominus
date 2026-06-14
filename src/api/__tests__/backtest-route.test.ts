import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { createBacktestRouter } from '../routes/backtest.js';
import { errorHandler } from '../middleware/error-handler.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('POST /api/v1/backtest', () => {
  let db: Database.Database;
  let outcomeRepo: OutcomeRepository;

  beforeEach(() => {
    db = openTestDb();
    outcomeRepo = new OutcomeRepository(db);
  });

  it('snapshot returns scanned/inserted/skipped counters', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/backtest', createBacktestRouter(db, outcomeRepo));
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
    app.use('/api/v1/backtest', createBacktestRouter(db, outcomeRepo));
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
    app.use('/api/v1/backtest', createBacktestRouter(db, outcomeRepo));
    app.use(errorHandler);

    const res = await request(app).post('/api/v1/backtest/suggest-weights');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sampleSize');
    expect(res.body).toHaveProperty('suggestions');
    expect(res.body).toHaveProperty('sumsToOne');
  });
});
