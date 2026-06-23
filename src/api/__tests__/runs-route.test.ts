import { describe, it, expect, beforeEach } from 'vitest';
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
});
