import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import type { CloseoutEntry } from '../../types/candidate.js';
import { createCandidatesRouter } from '../routes/candidates.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { PipelineRunService } from '../../app/pipeline-run-service.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function makeStubRunService(): PipelineRunService {
  return {
    runSync: vi.fn().mockResolvedValue({
      runId: 'stub',
      recommended: [],
      scored: [],
      allCandidates: [],
      stageSummary: {},
      totalDurationMs: 0,
      persistence: { candidatesPersisted: 0, scoresPersisted: 0 },
    }),
  } as unknown as PipelineRunService;
}

function buildApp(provider: SqliteProvider): express.Express {
  const candidateRepo = new CandidateRepository(provider);
  candidateRepo.insert({
    domain: 'alpha.com',
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Recommended,
    isPremium: false,
    pipelineRunId: 'run-1',
  });
  candidateRepo.insert({
    domain: 'beta.io',
    tld: '.io',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Recommended,
    isPremium: false,
    pipelineRunId: 'run-2',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/candidates', createCandidatesRouter(makeStubRunService(), candidateRepo));
  app.use(errorHandler);
  return app;
}

describe('Candidates API', () => {
  let provider: SqliteProvider;

  beforeEach(() => {
    provider = openTestDb();
  });

  describe('POST /api/v1/candidates/run', () => {
    it('forwards closeoutEntries to the run service', async () => {
      const runService = makeStubRunService();
      const app = express();
      app.use(express.json());
      app.use(
        '/api/v1/candidates',
        createCandidatesRouter(runService, new CandidateRepository(provider)),
      );
      app.use(errorHandler);

      const entries: CloseoutEntry[] = [
        { domain: 'expired.com', domainAge: 10, backlinks: 500, waybackSnapshots: 100 },
        { domain: 'aged.org', domainAge: 15 },
      ];

      await request(app).post('/api/v1/candidates/run').send({ closeoutEntries: entries });

      expect(runService.runSync).toHaveBeenCalledWith(
        expect.objectContaining({ closeoutEntries: entries }),
      );
    });

    it('forwards keywords, brandableNames, and closeoutDomains', async () => {
      const runService = makeStubRunService();
      const app = express();
      app.use(express.json());
      app.use(
        '/api/v1/candidates',
        createCandidatesRouter(runService, new CandidateRepository(provider)),
      );
      app.use(errorHandler);

      await request(app)
        .post('/api/v1/candidates/run')
        .send({
          keywords: ['cloud', 'saas'],
          brandableNames: ['getnova.com'],
          closeoutDomains: ['lastchance.net'],
        });

      expect(runService.runSync).toHaveBeenCalledWith({
        keywords: ['cloud', 'saas'],
        brandableNames: ['getnova.com'],
        closeoutDomains: ['lastchance.net'],
        closeoutEntries: undefined,
      });
    });
  });

  describe('GET /api/v1/candidates', () => {
    it('returns 400 with a clear error when runId is missing', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/v1/candidates');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toMatch(/runId/);
    });

    it('returns the candidates for the requested runId', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/v1/candidates?runId=run-1');
      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].domain).toBe('alpha.com');
    });

    it('returns an empty array for an unknown runId', async () => {
      const app = buildApp(provider);
      const res = await request(app).get('/api/v1/candidates?runId=does-not-exist');
      expect(res.status).toBe(200);
      expect(res.body.candidates).toEqual([]);
    });
  });
});
