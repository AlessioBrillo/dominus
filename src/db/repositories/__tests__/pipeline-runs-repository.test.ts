import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { PipelineRunsRepository } from '../pipeline-runs-repository.js';
import type { CompletePipelineRunInput } from '../pipeline-runs-repository.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeStartedRun(repo: PipelineRunsRepository, overrides: { runId?: string; startedAt?: string; retainedUntil?: string } = {}): void {
  repo.insert({
    runId: overrides.runId ?? `run-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: overrides.startedAt ?? '2026-06-07T10:00:00.000Z',
    hostVersion: '0.1.0',
    retainedUntil: overrides.retainedUntil ?? '2027-01-01T00:00:00.000Z',
  });
}

describe('PipelineRunsRepository', () => {
  let db: Database.Database;
  let repo: PipelineRunsRepository;

  beforeEach(() => {
    db = openTestDb();
    repo = new PipelineRunsRepository(db);
  });

  describe('insert + findById', () => {
    it('persists a started run with empty defaults', () => {
      // Act
      const run = repo.insert({
        runId: 'run-001',
        startedAt: '2026-06-07T10:00:00.000Z',
        hostVersion: '0.1.0',
        retainedUntil: '2027-01-01T00:00:00.000Z',
      });

      // Assert
      expect(run.runId).toBe('run-001');
      expect(run.startedAt).toBe('2026-06-07T10:00:00.000Z');
      expect(run.finishedAt).toBeNull();
      expect(run.totalDurationMs).toBeNull();
      expect(run.error).toBeNull();
      expect(run.stageSummary).toEqual({});
      expect(run.inputs).toEqual({
        keywords: 0,
        brandableNames: 0,
        closeoutDomains: 0,
        closeoutEntries: 0,
      });
      expect(run.resultsSummary).toEqual({
        candidatesEvaluated: 0,
        recommended: 0,
        trademarkBlocked: 0,
        unscored: 0,
        errors: 0,
      });
    });

    it('round-trips a run with full payload', () => {
      // Arrange
      const full = {
        runId: 'run-full',
        startedAt: '2026-06-07T10:00:00.000Z',
        finishedAt: '2026-06-07T10:00:05.000Z',
        totalDurationMs: 5000,
        stageSummary: { ScoringStage: { passed: 3, filtered: 2, durationMs: 100 } },
        inputs: { keywords: 5, brandableNames: 1, closeoutDomains: 0, closeoutEntries: 4 },
        resultsSummary: {
          candidatesEvaluated: 10,
          recommended: 3,
          trademarkBlocked: 1,
          unscored: 2,
          errors: 0,
        },
        hostVersion: '0.1.0',
        retainedUntil: '2027-01-01T00:00:00.000Z',
        error: null as string | null,
      };

      // Act
      repo.insert(full);
      const round = repo.findById('run-full');

      // Assert
      expect(round).toEqual(full);
    });

    it('returns null for an unknown runId', () => {
      // Act + Assert
      expect(repo.findById('does-not-exist')).toBeNull();
    });
  });

  describe('complete', () => {
    it('marks a run as finished with summary and error', () => {
      // Arrange
      makeStartedRun(repo, { runId: 'run-002' });

      const completion: CompletePipelineRunInput = {
        finishedAt: '2026-06-07T10:00:05.000Z',
        totalDurationMs: 5000,
        stageSummary: {
          CandidateGenerationStage: { passed: 5, filtered: 0, durationMs: 5 },
          ScoringStage: { passed: 3, filtered: 2, durationMs: 100 },
        },
        resultsSummary: {
          candidatesEvaluated: 5,
          recommended: 3,
          trademarkBlocked: 0,
          unscored: 0,
          errors: 0,
        },
      };

      // Act
      const updated = repo.complete('run-002', completion);

      // Assert
      expect(updated).not.toBeNull();
      expect(updated?.finishedAt).toBe('2026-06-07T10:00:05.000Z');
      expect(updated?.totalDurationMs).toBe(5000);
      expect(updated?.stageSummary).toEqual(completion.stageSummary);
      expect(updated?.resultsSummary).toEqual(completion.resultsSummary);
      expect(updated?.error).toBeNull();
    });

    it('records an error message when the run failed', () => {
      // Arrange
      makeStartedRun(repo, { runId: 'run-fail' });

      // Act
      const updated = repo.complete('run-fail', {
        finishedAt: '2026-06-07T10:00:01.000Z',
        totalDurationMs: 1000,
        stageSummary: {},
        resultsSummary: {
          candidatesEvaluated: 0, recommended: 0, trademarkBlocked: 0, unscored: 0, errors: 1,
        },
        error: 'EUIPO credentials missing',
      });

      // Assert
      expect(updated?.error).toBe('EUIPO credentials missing');
    });

    it('returns null when completing an unknown runId', () => {
      // Act + Assert
      expect(
        repo.complete('ghost', {
          finishedAt: '2026-06-07T10:00:01.000Z',
          totalDurationMs: 1,
          stageSummary: {},
          resultsSummary: {
            candidatesEvaluated: 0, recommended: 0, trademarkBlocked: 0, unscored: 0, errors: 0,
          },
        }),
      ).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns runs in descending started_at order', () => {
      // Arrange
      makeStartedRun(repo, { runId: 'a', startedAt: '2026-06-07T08:00:00.000Z' });
      makeStartedRun(repo, { runId: 'b', startedAt: '2026-06-07T10:00:00.000Z' });
      makeStartedRun(repo, { runId: 'c', startedAt: '2026-06-07T09:00:00.000Z' });

      // Act
      const ids = repo.findAll().map((r) => r.runId);

      // Assert
      expect(ids).toEqual(['b', 'c', 'a']);
    });

    it('honors since and until date filters', () => {
      // Arrange
      makeStartedRun(repo, { runId: 'a', startedAt: '2026-06-01T10:00:00.000Z' });
      makeStartedRun(repo, { runId: 'b', startedAt: '2026-06-07T10:00:00.000Z' });
      makeStartedRun(repo, { runId: 'c', startedAt: '2026-06-15T10:00:00.000Z' });

      // Act
      const inJune = repo.findAll({ since: '2026-06-01T00:00:00.000Z', until: '2026-06-30T23:59:59.999Z' });

      // Assert
      expect(inJune.map((r) => r.runId).sort()).toEqual(['a', 'b', 'c']);
    });

    it('respects the limit option', () => {
      // Arrange
      for (let i = 0; i < 5; i++) {
        makeStartedRun(repo, { runId: `r${i}`, startedAt: `2026-06-07T10:0${i}:00.000Z` });
      }

      // Act
      const limited = repo.findAll({ limit: 3 });

      // Assert
      expect(limited).toHaveLength(3);
    });

    it('returns an empty array when no runs are recorded', () => {
      // Act + Assert
      expect(repo.findAll()).toEqual([]);
    });
  });

  describe('prune', () => {
    it('removes runs whose retained_until is in the past', () => {
      // Arrange
      makeStartedRun(repo, { runId: 'old', retainedUntil: '2026-01-01T00:00:00.000Z' });
      makeStartedRun(repo, { runId: 'fresh', retainedUntil: '2027-01-01T00:00:00.000Z' });

      // Act
      const deleted = repo.prune('2026-06-07T00:00:00.000Z');

      // Assert
      expect(deleted).toBe(1);
      expect(repo.findById('old')).toBeNull();
      expect(repo.findById('fresh')).not.toBeNull();
    });

    it('is idempotent on a second call with the same threshold', () => {
      // Arrange
      makeStartedRun(repo, { runId: 'old', retainedUntil: '2026-01-01T00:00:00.000Z' });
      repo.prune('2026-06-07T00:00:00.000Z');

      // Act
      const secondDelete = repo.prune('2026-06-07T00:00:00.000Z');

      // Assert
      expect(secondDelete).toBe(0);
    });

    it('does not remove runs whose retained_until equals now', () => {
      // Arrange — `retained_until < now` is strict, equal is kept
      makeStartedRun(repo, { runId: 'boundary', retainedUntil: '2026-06-07T00:00:00.000Z' });

      // Act
      const deleted = repo.prune('2026-06-07T00:00:00.000Z');

      // Assert
      expect(deleted).toBe(0);
      expect(repo.findById('boundary')).not.toBeNull();
    });
  });

  describe('count', () => {
    it('reports the number of runs in the table', () => {
      // Arrange
      makeStartedRun(repo);
      makeStartedRun(repo);
      makeStartedRun(repo);

      // Act + Assert
      expect(repo.count()).toBe(3);
    });
  });
});
