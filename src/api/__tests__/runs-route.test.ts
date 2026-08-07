// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import { createRunsRouter } from '../routes/runs.js';
import { errorHandler } from '../middleware/error-handler.js';
import { UsageLimitExceededError } from '../../types/errors.js';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';
import type { JobQueueService } from '../../app/job-queue-service.js';
import type { PipelineProgressService } from '../../app/pipeline-progress-service.js';

interface RunRow {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  totalDurationMs: number | null;
  resultsSummary: { recommended: number; candidatesEvaluated: number };
  retainedUntil: string;
}

interface CandidateRow {
  domain: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface PruneBody {
  deleted: number;
  remaining: number;
}

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function buildApp(provider: SqliteProvider): {
  app: express.Express;
  runsRepo: PipelineRunsRepository;
  candidateRepo: CandidateRepository;
} {
  const runsRepo = new PipelineRunsRepository(provider);
  const candidateRepo = new CandidateRepository(provider);
  const scoringRepo = new ScoringRepository(provider);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/runs', createRunsRouter(runsRepo, candidateRepo, scoringRepo, provider.rawDb));
  app.use(errorHandler);
  return { app, runsRepo, candidateRepo };
}

function makeRunService(): PipelineRunService {
  return {
    enqueueRun: vi.fn().mockResolvedValue({ jobId: 'j-1', runId: 'r-q' }),
    runSync: vi.fn().mockResolvedValue({
      runId: 'r-sync',
      totalDurationMs: 42,
      recommended: [],
      scored: [],
      stageSummary: {},
      stageErrors: [],
      persistence: { inserted: 0 },
    }),
  } as unknown as PipelineRunService;
}

function makeJobQueueService(): JobQueueService {
  return {
    enqueuePipelineRun: vi.fn().mockResolvedValue({ jobId: 'j-1', runId: 'r-q' }),
  } as unknown as JobQueueService;
}

function buildFullApp(
  provider: SqliteProvider,
  overrides: {
    runService?: PipelineRunService | null;
    jobQueueService?: JobQueueService | null;
  } = {},
): { app: express.Express; runsRepo: PipelineRunsRepository } {
  const runsRepo = new PipelineRunsRepository(provider);
  const candidateRepo = new CandidateRepository(provider);
  const scoringRepo = new ScoringRepository(provider);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/runs',
    createRunsRouter(
      runsRepo,
      candidateRepo,
      scoringRepo,
      provider.rawDb,
      undefined,
      overrides.runService === undefined ? makeRunService() : (overrides.runService ?? undefined),
      overrides.jobQueueService === undefined
        ? undefined
        : (overrides.jobQueueService ?? undefined),
    ),
  );
  app.use(errorHandler);
  return { app, runsRepo };
}

describe('Runs API', () => {
  let provider: SqliteProvider;

  beforeEach(() => {
    provider = openTestDb();
  });

  describe('GET /api/v1/runs', () => {
    it('returns an empty array on a fresh database', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).get('/api/v1/runs');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ runs: [] });
    });

    it('returns runs newest-first with full pipeline_runs shape', async () => {
      // Arrange
      const { app, runsRepo } = buildApp(provider);
      runsRepo.insert({
        runId: 'r-old',
        startedAt: '2026-05-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-10-28T00:00:00.000Z',
      });
      runsRepo.insert({
        runId: 'r-new',
        startedAt: '2026-06-15T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-12-12T00:00:00.000Z',
      });

      // Act
      const res = await request(app).get('/api/v1/runs');

      // Assert
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
      const runs = res.body.runs as RunRow[];
      expect(runs[0]?.runId).toBe('r-new');
      expect(runs[0]?.retainedUntil).toBe('2026-12-12T00:00:00.000Z');
    });

    it('respects ?since filter', async () => {
      // Arrange
      const { app, runsRepo } = buildApp(provider);
      runsRepo.insert({
        runId: 'r-old',
        startedAt: '2026-05-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-10-28T00:00:00.000Z',
      });
      runsRepo.insert({
        runId: 'r-new',
        startedAt: '2026-06-15T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-12-12T00:00:00.000Z',
      });

      // Act
      const res = await request(app).get('/api/v1/runs?since=2026-06-01T00:00:00.000Z');

      // Assert
      expect(res.status).toBe(200);
      const runs = res.body.runs as RunRow[];
      expect(runs.map((r) => r.runId)).toEqual(['r-new']);
    });
  });

  describe('GET /api/v1/runs/:runId', () => {
    it('returns the full run record', async () => {
      // Arrange
      const { app, runsRepo } = buildApp(provider);
      runsRepo.insert({
        runId: 'r-1',
        startedAt: '2026-06-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-11-28T00:00:00.000Z',
      });
      runsRepo.complete('r-1', {
        finishedAt: '2026-06-01T00:00:01.000Z',
        totalDurationMs: 1000,
        stageSummary: { ScoringStage: { passed: 1, filtered: 0, durationMs: 4 } },
        resultsSummary: {
          candidatesEvaluated: 1,
          recommended: 1,
          trademarkBlocked: 0,
          unscored: 0,
          errors: 0,
        },
      });

      // Act
      const res = await request(app).get('/api/v1/runs/r-1');

      // Assert
      expect(res.status).toBe(200);
      const run = res.body.run as RunRow;
      expect(run.runId).toBe('r-1');
      expect(run.totalDurationMs).toBe(1000);
      expect(run.resultsSummary.recommended).toBe(1);
    });

    it('returns 404 RUN_NOT_FOUND for unknown id', async () => {
      // Arrange
      const { app } = buildApp(provider);

      // Act
      const res = await request(app).get('/api/v1/runs/nope');

      // Assert
      expect(res.status).toBe(404);
      const body = res.body as ErrorBody;
      expect(body.error.code).toBe('RUN_NOT_FOUND');
    });
  });

  describe('GET /api/v1/runs/:runId/candidates', () => {
    it('returns the candidates persisted during that run', async () => {
      // Arrange
      const { app, runsRepo, candidateRepo } = buildApp(provider);
      runsRepo.insert({
        runId: 'r-1',
        startedAt: '2026-06-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-11-28T00:00:00.000Z',
      });
      candidateRepo.upsert({
        domain: 'alpha.com',
        tld: '.com',
        source: CandidateSource.KeywordCombo,
        status: CandidateStatus.Recommended,
        isPremium: false,
        pipelineRunId: 'r-1',
      });
      candidateRepo.upsert({
        domain: 'beta.io',
        tld: '.io',
        source: CandidateSource.KeywordCombo,
        status: CandidateStatus.Recommended,
        isPremium: false,
        pipelineRunId: 'r-1',
      });
      candidateRepo.upsert({
        domain: 'other.com',
        tld: '.com',
        source: CandidateSource.KeywordCombo,
        status: CandidateStatus.Recommended,
        isPremium: false,
        pipelineRunId: 'r-2',
      });

      // Act
      const res = await request(app).get('/api/v1/runs/r-1/candidates');

      // Assert
      expect(res.status).toBe(200);
      const candidates = res.body.candidates as CandidateRow[];
      expect(candidates).toHaveLength(2);
      expect(candidates.map((c) => c.domain).sort()).toEqual(['alpha.com', 'beta.io']);
    });

    it('returns 404 when the run does not exist', async () => {
      // Arrange
      const { app } = buildApp(provider);

      // Act
      const res = await request(app).get('/api/v1/runs/missing/candidates');

      // Assert
      expect(res.status).toBe(404);
      const body = res.body as ErrorBody;
      expect(body.error.code).toBe('RUN_NOT_FOUND');
    });
  });

  describe('POST /api/v1/runs/prune', () => {
    it('deletes expired rows and reports counts', async () => {
      // Arrange
      const { app, runsRepo } = buildApp(provider);
      runsRepo.insert({
        runId: 'r-expired',
        startedAt: '2025-01-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2025-06-30T00:00:00.000Z',
      });
      runsRepo.insert({
        runId: 'r-kept',
        startedAt: new Date().toISOString(),
        hostVersion: '0.1.0',
        retainedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      // Act
      const res = await request(app).post('/api/v1/runs/prune');

      // Assert
      expect(res.status).toBe(200);
      const body = res.body as PruneBody;
      expect(body.deleted).toBe(1);
      expect(body.remaining).toBe(1);
      expect(await runsRepo.findById('r-expired')).toBeNull();
      expect(await runsRepo.findById('r-kept')).not.toBeNull();
    });
  });

  describe('GET /api/v1/runs/:runId/stream', () => {
    it('returns 501 when progress service is unavailable', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).get('/api/v1/runs/r-1/stream');
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('SSE_UNAVAILABLE');
    });

    it('registers the response with the progress service', async () => {
      const { runsRepo } = buildApp(provider);
      runsRepo.insert({
        runId: 'r-1',
        startedAt: '2026-06-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-11-28T00:00:00.000Z',
      });
      const progressService = {
        // Close the SSE response so the supertest request can complete.
        addClient: vi.fn((_runId: string, res: express.Response) => {
          res.end();
        }),
      } as unknown as PipelineProgressService;
      const app2 = express();
      app2.use(express.json());
      app2.use(
        '/api/v1/runs',
        createRunsRouter(
          runsRepo,
          new CandidateRepository(provider),
          new ScoringRepository(provider),
          provider.rawDb,
          progressService,
        ),
      );
      app2.use(errorHandler);

      const res = await request(app2).get('/api/v1/runs/r-1/stream');
      expect(res.status).toBe(200);
      expect(progressService.addClient).toHaveBeenCalledWith('r-1', expect.anything());
    });
  });

  describe('POST /api/v1/runs (job queue + sync paths)', () => {
    it('returns 400 when no input arrays are provided', async () => {
      const { app } = buildFullApp(provider, { runService: null });
      const res = await request(app).post('/api/v1/runs').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('enqueues the run and returns 202 with poll links', async () => {
      const runService = makeRunService();
      const jobQueueService = makeJobQueueService();
      const { app } = buildFullApp(provider, { runService, jobQueueService });
      const res = await request(app)
        .post('/api/v1/runs')
        .send({ keywords: ['coffee', ''] });
      expect(res.status).toBe(202);
      expect(res.body.runId).toBe('r-q');
      expect(res.body.jobId).toBe('j-1');
      expect(res.body.status).toBe('queued');
      expect(res.headers['location']).toContain('/api/v1/runs/r-q');
      expect(runService.enqueueRun).toHaveBeenCalledWith({
        keywords: ['coffee'],
        brandableNames: undefined,
        closeoutDomains: undefined,
      });
    });

    it('returns 501 when no run service is available', async () => {
      const { app } = buildFullApp(provider, { runService: null, jobQueueService: null });
      const res = await request(app)
        .post('/api/v1/runs')
        .send({ brandableNames: ['frobnicate'] });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    });

    it('runs synchronously and returns the summary', async () => {
      const runService = makeRunService();
      const { app } = buildFullApp(provider, { runService });
      const res = await request(app)
        .post('/api/v1/runs')
        .send({ closeoutDomains: ['expired.io'] });
      expect(res.status).toBe(200);
      expect(res.body.runId).toBe('r-sync');
      expect(res.body.status).toBe('completed');
      expect(res.body.durationMs).toBe(42);
      expect(runService.runSync).toHaveBeenCalledWith({
        keywords: undefined,
        brandableNames: undefined,
        closeoutDomains: ['expired.io'],
      });
    });

    it('returns 500 when the sync run fails', async () => {
      const runService = makeRunService();
      (runService.runSync as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('rdap exploded'),
      );
      const { app } = buildFullApp(provider, { runService });
      const res = await request(app)
        .post('/api/v1/runs')
        .send({ keywords: ['coffee'] });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('PIPELINE_RUN_FAILED');
      expect(res.body.error.message).toBe('rdap exploded');
    });

    it('returns structured 429 when the async enqueue rejects on allowance exhaustion', async () => {
      const runService = {
        enqueueRun: vi
          .fn()
          .mockRejectedValue(new UsageLimitExceededError('candidates_scored', 50, 2, 50)),
      } as unknown as PipelineRunService;
      const { app } = buildFullApp(provider, {
        runService,
        jobQueueService: makeJobQueueService(),
      });
      const res = await request(app)
        .post('/api/v1/runs')
        .send({ keywords: ['coffee', 'roast'] });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('USAGE_LIMIT_EXCEEDED');
      expect(res.body.usage.feature).toBe('candidates_scored');
      expect(res.body.usage.current).toBe(50);
      expect(res.body.usage.requested).toBe(2);
      expect(res.body.usage.limitValue).toBe(50);
    });

    it('returns structured 429 from the sync path when the allowance is exhausted', async () => {
      const runService = {
        runSync: vi
          .fn()
          .mockRejectedValue(new UsageLimitExceededError('candidates_scored', 50, 1, 50)),
      } as unknown as PipelineRunService;
      const { app } = buildFullApp(provider, { runService, jobQueueService: null });
      const res = await request(app)
        .post('/api/v1/runs')
        .send({ keywords: ['coffee'] });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('USAGE_LIMIT_EXCEEDED');
      expect(res.body.usage.feature).toBe('candidates_scored');
      expect(res.body.usage.limitValue).toBe(50);
    });
  });

  describe('GET /api/v1/runs/:runId/job', () => {
    it('returns 404 for an unknown run', async () => {
      const { app } = buildApp(provider);
      const res = await request(app).get('/api/v1/runs/nope/job');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RUN_NOT_FOUND');
    });

    it('reports not_available without a job queue service', async () => {
      const { app, runsRepo } = buildApp(provider);
      runsRepo.insert({
        runId: 'r-done',
        startedAt: '2026-06-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-11-28T00:00:00.000Z',
      });
      runsRepo.complete('r-done', {
        finishedAt: '2026-06-01T00:00:01.000Z',
        totalDurationMs: 10,
        stageSummary: {},
        resultsSummary: {
          candidatesEvaluated: 0,
          recommended: 0,
          trademarkBlocked: 0,
          unscored: 0,
          errors: 0,
        },
      });
      const res = await request(app).get('/api/v1/runs/r-done/job');
      expect(res.status).toBe(200);
      expect(res.body.jobStatus).toBe('not_available');
    });

    it('reports completed for a finished run with a job queue service', async () => {
      const { app, runsRepo } = buildFullApp(provider, { jobQueueService: makeJobQueueService() });
      runsRepo.insert({
        runId: 'r-done',
        startedAt: '2026-06-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-11-28T00:00:00.000Z',
      });
      runsRepo.complete('r-done', {
        finishedAt: '2026-06-01T00:00:01.000Z',
        totalDurationMs: 10,
        stageSummary: {},
        resultsSummary: {
          candidatesEvaluated: 0,
          recommended: 0,
          trademarkBlocked: 0,
          unscored: 0,
          errors: 0,
        },
      });
      const res = await request(app).get('/api/v1/runs/r-done/job');
      expect(res.status).toBe(200);
      expect(res.body.jobStatus).toBe('completed');
    });

    it('reports in_progress for an unfinished run', async () => {
      const { app, runsRepo } = buildFullApp(provider, { jobQueueService: makeJobQueueService() });
      runsRepo.insert({
        runId: 'r-run',
        startedAt: '2026-06-01T00:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2026-11-28T00:00:00.000Z',
      });
      const res = await request(app).get('/api/v1/runs/r-run/job');
      expect(res.status).toBe(200);
      expect(res.body.jobStatus).toBe('in_progress');
    });
  });
});
