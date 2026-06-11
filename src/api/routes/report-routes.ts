import { Router } from 'express';
import type { PortfolioReportService } from '../../portfolio/portfolio-report-service.js';

export function createReportRouter(reportService: PortfolioReportService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const report = await reportService.generate();
      res.json(report);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'REPORT_ERROR', message } });
    }
  });

  router.get('/tld', async (_req, res) => {
    try {
      const report = await reportService.generate();
      res.json(report.breakdownByTld);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'REPORT_ERROR', message } });
    }
  });

  router.get('/risk', async (_req, res) => {
    try {
      const report = await reportService.generate();
      res.json(report.domainsAtRisk);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'REPORT_ERROR', message } });
    }
  });

  router.get('/roi', async (_req, res) => {
    try {
      const report = await reportService.allRoi();
      res.json(report);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'REPORT_ERROR', message } });
    }
  });

  return router;
}
