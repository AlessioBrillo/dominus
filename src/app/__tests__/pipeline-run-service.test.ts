import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import { PipelineRunService } from '../pipeline-run-service.js';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import type { PipelineOrchestrator, PipelineResult } from '../../pipeline/orchestrator.js';
import type { ScoredCandidate } from '../../pipeline/stages/scoring-stage.js';
import type { DomainCandidate } from '../../types/candidate.js';
import type { ScoreResult } from '../../types/score.js';

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
    expectedValue: 200,
    confidence: 0.65,
    suggestedBuyMax: 100,
    suggestedListPrice: 600,
    weightedScore: 0.55,
    breakdown: {
      intrinsic: { score: 0.8, weight: 0.3, details: {} },
      commercial: { score: 0.5, weight: 0.35, details: { monthlySearchVolume: 0 } },
      market: { score: 0.4, weight: 0.25, details: { comparables: 0 }, medianSalePrice: 0 } as ScoreResult['breakdown']['market'] & { medianSalePrice: number },
      expiry: { score: 0.0, weight: 0.1, details: {} },
    },
    recommended: true,
    scoredAt: new Date().toISOString(),
  };
}

function makeScoredCandidate(domain: string, recommended = true): ScoredCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.CloseoutCsv,
    status: recommended ? CandidateStatus.Recommended : CandidateStatus.Scored,
    isPremium: false,
    pipelineRunId: 'run-abc',
    scoreResult: makeScoreResult(domain),
  };
}

function makeRawCandidate(domain: string, status: CandidateStatus): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.CloseoutCsv,
    status,
    isPremium: false,
    pipelineRunId: 'run-abc',
  };
}

function makeMockOrchestrator(result: PipelineResult): PipelineOrchestrator {
  return { run: vi.fn().mockResolvedValue(result) } as unknown as PipelineOrchestrator;
}

describe('PipelineRunService', () => {
  it('returns the pipeline result enriched with persistence summary', async () => {
    // Arrange
    const db = openTestDb();
    const recommended = makeScoredCandidate('nova.com', true);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [recommended],
      scored: [recommended],
      allCandidates: [recommended],
      stageSummary: {},
      totalDurationMs: 42,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    const runResult = await service.run({ closeoutDomains: ['nova.com'] });

    // Assert
    expect(runResult.runId).toBe('run-abc');
    expect(runResult.persistence.candidatesPersisted).toBe(1);
    expect(runResult.persistence.scoresPersisted).toBe(1);
  });

  it('persists candidate rows to SQLite', async () => {
    // Arrange
    const db = openTestDb();
    const recommended = makeScoredCandidate('sol.com', true);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [recommended],
      scored: [recommended],
      allCandidates: [recommended],
      stageSummary: {},
      totalDurationMs: 10,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    await service.run({});

    // Assert — row exists in candidates table
    const row = db.prepare('SELECT domain, status FROM candidates WHERE domain = ?').get('sol.com') as { domain: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.domain).toBe('sol.com');
    expect(row?.status).toBe(CandidateStatus.Recommended);
  });

  it('persists scoring_runs rows to SQLite', async () => {
    // Arrange
    const db = openTestDb();
    const scored = makeScoredCandidate('arc.com', true);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [scored],
      scored: [scored],
      allCandidates: [scored],
      stageSummary: {},
      totalDurationMs: 10,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    await service.run({});

    // Assert — scoring row exists
    const count = db.prepare('SELECT COUNT(*) as cnt FROM scoring_runs').get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('upserts on a second run of the same domains without throwing', async () => {
    // Arrange
    const db = openTestDb();
    const candidate = makeScoredCandidate('vex.com', true);
    const result: PipelineResult = {
      runId: 'run-001',
      recommended: [candidate],
      scored: [candidate],
      allCandidates: [candidate],
      stageSummary: {},
      totalDurationMs: 5,
    };

    const candidateRepo = new CandidateRepository(db);
    const scoringRepo = new ScoringRepository(db);

    const service1 = new PipelineRunService(db, makeMockOrchestrator(result), candidateRepo, scoringRepo);
    await service1.run({});

    // Second run — same domain, new runId
    const result2: PipelineResult = { ...result, runId: 'run-002' };
    const service2 = new PipelineRunService(db, makeMockOrchestrator(result2), candidateRepo, scoringRepo);

    // Act + Assert — no UNIQUE crash
    await expect(service2.run({})).resolves.toBeDefined();

    // One candidate row (upserted), two scoring rows (history preserved)
    const candCount = db.prepare('SELECT COUNT(*) as cnt FROM candidates').get() as { cnt: number };
    const scoreCount = db.prepare('SELECT COUNT(*) as cnt FROM scoring_runs').get() as { cnt: number };
    expect(candCount.cnt).toBe(1);
    expect(scoreCount.cnt).toBe(2);
  });

  it('persists all candidates including dns/rdap-filtered ones', async () => {
    // Arrange
    const db = openTestDb();
    const dnsFiltered = makeRawCandidate('registered.com', CandidateStatus.DnsFiltered);
    const recommended = makeScoredCandidate('free.com', true);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [recommended],
      scored: [recommended],
      allCandidates: [dnsFiltered, recommended],
      stageSummary: {},
      totalDurationMs: 10,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    await service.run({});

    // Assert — both rows persisted
    const count = db.prepare('SELECT COUNT(*) as cnt FROM candidates').get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it('does not write a scoring row for candidates without a scoreResult', async () => {
    // Arrange
    const db = openTestDb();
    const dnsFiltered = makeRawCandidate('registered.com', CandidateStatus.DnsFiltered);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [],
      scored: [],             // no scored candidates
      allCandidates: [dnsFiltered],
      stageSummary: {},
      totalDurationMs: 5,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    await service.run({});

    // Assert — one candidate, zero scores
    const scoreCount = db.prepare('SELECT COUNT(*) as cnt FROM scoring_runs').get() as { cnt: number };
    expect(scoreCount.cnt).toBe(0);
  });
});

describe('PipelineRunService — pipeline_runs history (ADR-0011)', () => {
  it('inserts a pipeline_runs row before orchestrator.run and completes it on success', async () => {
    // Arrange
    const db = openTestDb();
    const candidate = makeScoredCandidate('nova.com', true);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [candidate],
      scored: [candidate],
      allCandidates: [candidate],
      stageSummary: { 'ScoringStage': { passed: 1, filtered: 0, durationMs: 5 } },
      totalDurationMs: 42,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    const out = await service.run({ closeoutDomains: ['nova.com'] });

    // Assert — pipeline_runs row exists, completed, no error
    const row = db.prepare('SELECT * FROM pipeline_runs WHERE run_id = ?').get(out.runRowId) as
      | { run_id: string; finished_at: string | null; total_duration_ms: number | null; error: string | null; host_version: string; inputs: string; results_summary: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.finished_at).not.toBeNull();
    expect(row?.total_duration_ms).toBeGreaterThanOrEqual(0);
    expect(row?.error).toBeNull();
    expect(row?.host_version).toMatch(/^\d+\.\d+\.\d+/);
    const inputs = JSON.parse(row?.inputs ?? '{}') as { closeoutDomains: number };
    expect(inputs.closeoutDomains).toBe(1);
  });

  it('computes retained_until as started_at + 180 days', async () => {
    // Arrange
    const db = openTestDb();
    const candidate = makeScoredCandidate('nova.com', true);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [candidate],
      scored: [candidate],
      allCandidates: [candidate],
      stageSummary: {},
      totalDurationMs: 10,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    const out = await service.run({});

    // Assert
    const row = db.prepare('SELECT started_at, retained_until FROM pipeline_runs WHERE run_id = ?').get(out.runRowId) as
      | { started_at: string; retained_until: string } | undefined;
    expect(row).toBeDefined();
    const diffMs = new Date(row!.retained_until).getTime() - new Date(row!.started_at).getTime();
    const expectedMs = 180 * 24 * 60 * 60 * 1000;
    expect(diffMs).toBe(expectedMs);
  });

  it('persists stage_summary and results_summary as JSON', async () => {
    // Arrange
    const db = openTestDb();
    const candidate = makeScoredCandidate('nova.com', true);
    const result: PipelineResult = {
      runId: 'run-abc',
      recommended: [candidate],
      scored: [candidate],
      allCandidates: [candidate],
      stageSummary: { 'ScoringStage': { passed: 1, filtered: 0, durationMs: 3 } },
      totalDurationMs: 10,
    };
    const service = new PipelineRunService(
      db,
      makeMockOrchestrator(result),
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act
    const out = await service.run({});

    // Assert
    const row = db.prepare('SELECT stage_summary, results_summary FROM pipeline_runs WHERE run_id = ?').get(out.runRowId) as
      | { stage_summary: string; results_summary: string } | undefined;
    const stage = JSON.parse(row?.stage_summary ?? '{}') as Record<string, { passed: number }>;
    const results = JSON.parse(row?.results_summary ?? '{}') as { recommended: number; candidatesEvaluated: number };
    expect(stage.ScoringStage?.passed).toBe(1);
    expect(results.recommended).toBe(1);
    expect(results.candidatesEvaluated).toBe(1);
  });

  it('completes the row with error=message and rethrows on orchestrator failure', async () => {
    // Arrange
    const db = openTestDb();
    const orchestrator: PipelineOrchestrator = {
      run: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as PipelineOrchestrator;
    const service = new PipelineRunService(
      db,
      orchestrator,
      new CandidateRepository(db),
      new ScoringRepository(db),
    );

    // Act + Assert
    await expect(service.run({})).rejects.toThrow('boom');

    const row = db.prepare('SELECT error, finished_at FROM pipeline_runs ORDER BY started_at DESC LIMIT 1').get() as
      | { error: string | null; finished_at: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.error).toBe('boom');
    expect(row?.finished_at).not.toBeNull();
  });
});
