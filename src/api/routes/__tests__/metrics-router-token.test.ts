// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createMetricsRouter } from '../metrics.js';
import type { MetricsRepository } from '../../../db/repositories/metrics-repository.js';
import type { MetricsCollector } from '../../../app/metrics-collector.js';
import type { JobQueueRepository } from '../../../db/repositories/job-queue-repository.js';
import type { MetricsSnapshot } from '../../../types/metrics.js';
import type { JobQueueStats } from '../../../types/job-queue.js';

const snapshot: MetricsSnapshot = {
  pipeline: {
    totalRuns: 0,
    totalCandidatesEvaluated: 0,
    totalRecommended: 0,
    lastRunAt: null,
    lastRunDurationMs: null,
    stageMetrics: {},
    providerMetrics: {},
  },
  system: {
    uptimeSeconds: 1,
    memoryUsageMb: 10,
    pid: 1,
    version: 'test',
    timestamp: '2026-08-06T00:00:00.000Z',
  },
  backup: {
    lastSuccessAtMs: null,
    pitrWalLagBytes: null,
    pitrBaseBackupAgeHours: null,
    pitrArchivingActive: null,
    pitrCheckedAtMs: null,
  },
};

const queueStats: JobQueueStats = {
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  deadLetter: 0,
  total: 0,
};

function buildApp(options?: { token?: string }): express.Express {
  const metricsRepo = {
    getAggregates: vi.fn().mockResolvedValue([]),
    findRecentRuns: vi.fn().mockResolvedValue([]),
    findByRunId: vi.fn().mockResolvedValue([]),
  } as unknown as MetricsRepository;
  const collector = {
    snapshot: vi.fn().mockReturnValue(snapshot),
  } as unknown as MetricsCollector;
  const jobQueueRepo = {
    getStats: vi.fn().mockResolvedValue(queueStats),
    countDeadLetter: vi.fn().mockResolvedValue(0),
  } as unknown as JobQueueRepository;

  const app = express();
  app.use('/api/v1/metrics', createMetricsRouter(metricsRepo, collector, jobQueueRepo, options));
  return app;
}

describe('createMetricsRouter bearer-token gating', () => {
  it('serves metrics publicly when no token is configured (backward compatible)', async () => {
    const res = await request(buildApp()).get('/api/v1/metrics/').expect(200);
    expect(res.body).toHaveProperty('current');
  });

  it('rejects requests without a bearer token when one is configured', async () => {
    const res = await request(buildApp({ token: 'secret-token' }))
      .get('/api/v1/metrics/')
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with a wrong bearer token when one is configured', async () => {
    await request(buildApp({ token: 'secret-token' }))
      .get('/api/v1/metrics/')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
  });

  it('accepts requests with the correct bearer token', async () => {
    const res = await request(buildApp({ token: 'secret-token' }))
      .get('/api/v1/metrics/')
      .set('Authorization', 'Bearer secret-token')
      .expect(200);
    expect(res.body).toHaveProperty('current');
  });

  it('rejects non-Bearer authorization schemes', async () => {
    await request(buildApp({ token: 'secret-token' }))
      .get('/api/v1/metrics/')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);
  });

  it('gates the Prometheus endpoint too', async () => {
    const res = await request(buildApp({ token: 'secret-token' }))
      .get('/api/v1/metrics/prometheus')
      .set('Authorization', 'Bearer secret-token')
      .expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});
