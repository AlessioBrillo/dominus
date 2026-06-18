import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrator.js';
import { SqliteProvider } from '../../../db/provider/sqlite-adapter.js';
import { createReportRouter } from '../report-routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { PortfolioRepository } from '../../../db/repositories/portfolio-repository.js';
import { OutcomeRepository } from '../../../db/repositories/outcome-repository.js';
import { PortfolioReportService } from '../../../portfolio/portfolio-report-service.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('GET /api/v1/report', () => {
  let provider: SqliteProvider;
  let reportService: PortfolioReportService;

  beforeEach(() => {
    provider = openTestDb();
    const portfolioRepo = new PortfolioRepository(provider);
    const outcomeRepo = new OutcomeRepository(provider);
    reportService = new PortfolioReportService(portfolioRepo, outcomeRepo, 25, 30);
  });

  it('returns empty report when portfolio is empty', async () => {
    const app = express();
    app.use('/api/v1/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/report');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalDomains', 0);
    expect(res.body).toHaveProperty('breakdownByTld');
    expect(res.body).toHaveProperty('domainsAtRisk');
  });

  it('GET /api/v1/report/tld returns breakdown by TLD', async () => {
    const app = express();
    app.use('/api/v1/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/report/tld');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/v1/report/risk returns domains at risk', async () => {
    const app = express();
    app.use('/api/v1/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/report/risk');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/v1/report/roi returns ROI report', async () => {
    const app = express();
    app.use('/api/v1/report', createReportRouter(reportService));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/report/roi');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalDomains', 0);
    expect(res.body).toHaveProperty('roiPct');
    expect(res.body).toHaveProperty('domainDetails');
  });
});
