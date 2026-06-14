import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { RenewalAlertRepository } from '../../db/repositories/renewal-alert-repository.js';
import { createAlertsRouter } from '../routes/alerts.js';
import { errorHandler } from '../middleware/error-handler.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';

function createApp(): { app: express.Express; alertRepo: RenewalAlertRepository } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const portfolioRepo = new PortfolioRepository(db);
  const alertRepo = new RenewalAlertRepository(db);

  // Insert a portfolio entry so FK constraints are satisfied
  portfolioRepo.insert({
    domain: 'example.com',
    tld: 'com',
    acquiredAt: '2025-01-01',
    renewalDate: '2026-07-01',
    acquisitionCost: 10,
    renewalCost: 15,
    registrar: 'test',
  });

  // Create a sample alert
  alertRepo.upsert(
    {
      domain: 'example.com',
      portfolioEntryId: 1,
      alertType: AlertType.RenewalImminent,
      severity: AlertSeverity.Warning,
      message: 'Domain renews in 25 days',
    },
    ['console'],
  );

  const app = express();
  app.use(express.json());
  app.use('/api/v1/alerts', createAlertsRouter({ alertRepo }));
  app.use(errorHandler);

  return { app, alertRepo };
}

describe('GET /api/v1/alerts', () => {
  it('returns all alerts', async () => {
    const { app } = createApp();
    const res = await request(app).get('/api/v1/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]?.domain).toBe('example.com');
  });

  it('filters by domain', async () => {
    const { app } = createApp();
    const res = await request(app).get('/api/v1/alerts?domain=example.com');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
  });

  it('returns empty array for unknown domain', async () => {
    const { app } = createApp();
    const res = await request(app).get('/api/v1/alerts?domain=unknown.com');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toEqual([]);
  });

  it('filters unacknowledged alerts', async () => {
    const { app } = createApp();
    const res = await request(app).get('/api/v1/alerts?unacknowledged=true');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
  });
});

describe('POST /api/v1/alerts/:id/acknowledge', () => {
  it('acknowledges an existing alert', async () => {
    const { app } = createApp();
    const res = await request(app).post('/api/v1/alerts/1/acknowledge');
    expect(res.status).toBe(200);
    expect(res.body.alert.acknowledgedAt).toBeDefined();
  });

  it('returns 404 for unknown alert', async () => {
    const { app } = createApp();
    const res = await request(app).post('/api/v1/alerts/999/acknowledge');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/alerts/acknowledge-all', () => {
  it('acknowledges all alerts', async () => {
    const { app } = createApp();
    const res = await request(app).post('/api/v1/alerts/acknowledge-all').send({});
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(1);
  });
});

describe('POST /api/v1/alerts/run', () => {
  it('returns 503 when alert engine is not configured', async () => {
    const { app } = createApp();
    const res = await request(app).post('/api/v1/alerts/run');
    expect(res.status).toBe(503);
  });
});
