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
