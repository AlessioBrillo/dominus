import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrator.js';
import { createReportRouter } from '../report-routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { PortfolioRepository } from '../../../db/repositories/portfolio-repository.js';
import { OutcomeRepository } from '../../../db/repositories/outcome-repository.js';
import { PortfolioReportService } from '../../../portfolio/portfolio-report-service.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('GET /api/report', () => {
  let db: Database.Database;
  let reportService: PortfolioReportService;

  beforeEach(() => {
    db = openTestDb();
    const portfolioRepo = new PortfolioRepository(db);
    const outcomeRepo = new OutcomeRepository(db);
    reportService = new PortfolioReportService(portfolioRepo, outcomeRepo, 25, 30);
  });

  it('returns empty report when portfolio is empty', async () => {
    const app = express();
    app.use('/api/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/report');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalDomains', 0);
    expect(res.body).toHaveProperty('breakdownByTld');
    expect(res.body).toHaveProperty('domainsAtRisk');
  });

  it('GET /api/report/tld returns breakdown by TLD', async () => {
    const app = express();
    app.use('/api/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/report/tld');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/report/risk returns domains at risk', async () => {
    const app = express();
    app.use('/api/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/report/risk');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/report/roi returns ROI report', async () => {
    const app = express();
    app.use('/api/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/report/roi');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalDomains', 0);
    expect(res.body).toHaveProperty('roiPct');
    expect(res.body).toHaveProperty('domainDetails');
  });
});
