import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrator.js';
import { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import { CandidateRepository } from '../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../db/repositories/scoring-repository.js';
import type { PipelineOrchestrator, PipelineResult } from '../pipeline/orchestrator.js';
import {
  PipelineRunService,
  DEFAULT_PIPELINE_RUN_RETENTION_DAYS,
} from '../app/pipeline-run-service.js';
import { CandidateSource, CandidateStatus } from '../types/candidate.js';
import type { ScoredCandidate } from '../pipeline/stages/scoring-stage.js';
import type { DomainCandidate } from '../types/candidate.js';
import type { ScoreResult } from '../types/score.js';
import express from 'express';
import request from 'supertest';
import { createRunsRouter } from '../api/routes/runs.js';
import { errorHandler } from '../api/middleware/error-handler.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeScoreResult(domain: string): ScoreResult {
  return {
    domain,
    expectedValue: 250,
    confidence: 0.7,
    suggestedBuyMax: 120,
    suggestedListPrice: 700,
    weightedScore: 0.6,
    breakdown: {
      intrinsic: { score: 0.85, weight: 0.3, details: {} },
      commercial: { score: 0.55, weight: 0.35, details: { monthlySearchVolume: 100 } },
      market: {
        score: 0.5,
        weight: 0.25,
        details: { comparables: 1 },
        medianSalePrice: 350,
      } as ScoreResult['breakdown']['market'] & { medianSalePrice: number },
      expiry: { score: 0.0, weight: 0.1, details: {} },
    },
    recommended: true,
    scoredAt: new Date().toISOString(),
  };
}

function makeScoredCandidate(domain: string, recommended: boolean, tld = '.com'): ScoredCandidate {
  return {
    domain,
    tld,
    source: CandidateSource.CloseoutCsv,
    status: recommended ? CandidateStatus.Recommended : CandidateStatus.Scored,
    isPremium: false,
    pipelineRunId: 'orchestrator-run-id',
    scoreResult: makeScoreResult(domain),
  };
}

function makeMockOrchestrator(result: PipelineResult): PipelineOrchestrator {
  return { run: () => Promise.resolve(result) } as unknown as PipelineOrchestrator;
}

interface IntegrationDeps {
  service: PipelineRunService;
  runsRepo: PipelineRunsRepository;
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
  db: Database.Database;
}

function buildIntegration(db: Database.Database): IntegrationDeps {
  const runsRepo = new PipelineRunsRepository(db);
  const candidateRepo = new CandidateRepository(db);
  const scoringRepo = new ScoringRepository(db);

  const scored = makeScoredCandidate('alpha.com', true);
  const blocked = makeScoredCandidate('beta.io', false, '.io');
  const orchestratorResult: PipelineResult = {
    runId: 'orchestrator-run-id',
    recommended: [scored],
    scored: [scored, blocked],
    allCandidates: [
      scored,
      blocked,
      {
        domain: 'noise.com',
        tld: '.com',
        source: CandidateSource.KeywordCombo,
        status: CandidateStatus.DnsFiltered,
        isPremium: false,
        pipelineRunId: 'orchestrator-run-id',
      } as DomainCandidate,
    ],
    stageSummary: {
      CandidateGenerationStage: { passed: 3, filtered: 0, durationMs: 1 },
      DnsPreFilterStage: { passed: 2, filtered: 1, durationMs: 1 },
      RdapConfirmationStage: { passed: 2, filtered: 0, durationMs: 1 },
      ScoringStage: { passed: 2, filtered: 0, durationMs: 5 },
      TrademarkGateStage: { passed: 1, filtered: 1, durationMs: 3 },
    },
    totalDurationMs: 12,
  };

  const service = new PipelineRunService(
    db,
    makeMockOrchestrator(orchestratorResult),
    candidateRepo,
    scoringRepo,
    runsRepo,
  );

  return { service, runsRepo, candidateRepo, scoringRepo, db };
}

describe('pipeline_runs — end-to-end (ADR-0011)', () => {
  let db: Database.Database;
  let deps: IntegrationDeps;

  beforeEach(() => {
    db = openTestDb();
    deps = buildIntegration(db);
  });

  it('a run() call writes a complete pipeline_runs row + 3 candidates + 2 scoring_runs', async () => {
    // Act
    const result = await deps.service.run({
      closeoutDomains: ['alpha.com', 'beta.io', 'noise.com'],
    });

    // Assert — pipeline_runs row
    const row = deps.runsRepo.findById(result.runRowId);
    expect(row).not.toBeNull();
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.error).toBeNull();
    expect(row?.totalDurationMs).toBeGreaterThanOrEqual(0);

    // Assert — candidates (linked to the service-level runRowId after alignment)
    const candCount = db
      .prepare('SELECT COUNT(*) AS n FROM candidates WHERE pipeline_run_id = ?')
      .get(result.runRowId) as { n: number };
    expect(candCount.n).toBe(3);

    // Assert — scoring_runs (linked to the service-level runRowId after alignment)
    const scoreCount = db
      .prepare('SELECT COUNT(*) AS n FROM scoring_runs WHERE run_id = ?')
      .get(result.runRowId) as { n: number };
    expect(scoreCount.n).toBe(2);
  });

  it('retained_until equals started_at + 180 days', async () => {
    // Act
    const result = await deps.service.run({});

    // Assert
    const row = deps.runsRepo.findById(result.runRowId);
    const start = new Date(row!.startedAt).getTime();
    const retain = new Date(row!.retainedUntil).getTime();
    const expected = DEFAULT_PIPELINE_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(retain - start).toBe(expected);
  });

  it('inputs snapshot reflects the call arguments', async () => {
    // Act
    const result = await deps.service.run({
      keywords: ['alpha', 'beta'],
      brandableNames: ['zenly'],
      closeoutDomains: ['a.com', 'b.com'],
    });

    // Assert
    const row = deps.runsRepo.findById(result.runRowId);
    expect(row?.inputs).toEqual({
      keywords: 2,
      brandableNames: 1,
      closeoutDomains: 2,
      closeoutEntries: 0,
    });
  });

  it('results_summary.recommended matches the orchestrator result', async () => {
    // Act
    const result = await deps.service.run({});

    // Assert
    const row = deps.runsRepo.findById(result.runRowId);
    expect(row?.resultsSummary.recommended).toBe(1);
    expect(row?.resultsSummary.candidatesEvaluated).toBe(3);
  });

  it('a second run() creates a second row, leaving the first intact', async () => {
    // Act
    const r1 = await deps.service.run({});
    const r2 = await deps.service.run({});

    // Assert
    expect(deps.runsRepo.count()).toBe(2);
    expect(deps.runsRepo.findById(r1.runRowId)).not.toBeNull();
    expect(deps.runsRepo.findById(r2.runRowId)).not.toBeNull();
  });

  it('orchestrator failure completes the row with error=message and rethrows', async () => {
    // Arrange — swap the orchestrator for one that throws
    const failingService = new PipelineRunService(
      db,
      {
        run: () => Promise.reject(new Error('upstream RDAP timed out')),
      } as unknown as PipelineOrchestrator,
      deps.candidateRepo,
      deps.scoringRepo,
      deps.runsRepo,
    );

    // Act + Assert
    await expect(failingService.run({})).rejects.toThrow('upstream RDAP timed out');

    // The error row is the newest one
    const all = deps.runsRepo.findAll({ limit: 1 });
    expect(all).toHaveLength(1);
    expect(all[0]?.error).toBe('upstream RDAP timed out');
    expect(all[0]?.finishedAt).not.toBeNull();
  });

  it('CLI + REST share the same pipeline_runs table', async () => {
    // Act — run the service
    const result = await deps.service.run({});

    // REST: GET /api/runs
    const app = express();
    app.use(express.json());
    app.use('/api/runs', createRunsRouter(deps.runsRepo, deps.candidateRepo, deps.scoringRepo, db));
    app.use(errorHandler);
    const res = await request(app).get('/api/runs');
    expect(res.status).toBe(200);
    const listBody = res.body as {
      runs: Array<{ runId: string; resultsSummary: { recommended: number } }>;
    };
    expect(listBody.runs).toHaveLength(1);
    expect(listBody.runs[0]?.runId).toBe(result.runRowId);
    expect(listBody.runs[0]?.resultsSummary.recommended).toBe(1);

    // REST: GET /api/runs/:runId/candidates
    // The service aligns candidate + scoring_runs pipeline_run_id to the
    // service-level runRowId, so the REST endpoint can join on
    // pipeline_runs.run_id.
    const candRes = await request(app).get(`/api/runs/${result.runRowId}/candidates`);
    expect(candRes.status).toBe(200);
    const candBody = candRes.body as { runId: string; candidates: Array<{ domain: string }> };
    expect(candBody.runId).toBe(result.runRowId);
    expect(candBody.candidates.map((c) => c.domain).sort()).toEqual([
      'alpha.com',
      'beta.io',
      'noise.com',
    ]);
  });
});
