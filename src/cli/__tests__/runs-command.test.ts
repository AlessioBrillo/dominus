import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { runMigrations } from '../../db/migrator.js';
import { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import { registerRunsCommand } from '../commands/runs-command.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function buildProgram(db: Database.Database): { program: Command; repo: PipelineRunsRepository } {
  const repo = new PipelineRunsRepository(db);
  const program = new Command();
  registerRunsCommand(program, { runsRepo: repo });
  return { program, repo };
}

function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = original;
    })
    .then((): string => buffer);
}

function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stderr.write = original;
    })
    .then((): string => buffer);
}

describe('CLI: dominus runs', () => {
  let db: Database.Database;
  let repo: PipelineRunsRepository;
  let program: Command;

  beforeEach(() => {
    db = openTestDb();
    ({ program, repo } = buildProgram(db));
  });

  it('list prints "No pipeline runs recorded yet." when empty', async () => {
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'runs', 'list']);
    });
    expect(out).toContain('No pipeline runs recorded yet.');
  });

  it('list prints a table of inserted runs', async () => {
    // Arrange
    const t0 = new Date('2026-06-01T10:00:00.000Z').toISOString();
    const t1 = new Date('2026-06-02T11:00:00.000Z').toISOString();
    repo.insert({
      runId: 'aaaaaaaa-1111-2222-3333-444444444444',
      startedAt: t0,
      hostVersion: '0.1.0',
      retainedUntil: new Date('2026-11-28T10:00:00.000Z').toISOString(),
    });
    repo.complete('aaaaaaaa-1111-2222-3333-444444444444', {
      finishedAt: t0,
      totalDurationMs: 250,
      stageSummary: { ScoringStage: { passed: 1, filtered: 0, durationMs: 5 } },
      resultsSummary: {
        candidatesEvaluated: 1,
        recommended: 1,
        trademarkBlocked: 0,
        unscored: 0,
        errors: 0,
      },
    });
    repo.insert({
      runId: 'bbbbbbbb-1111-2222-3333-444444444444',
      startedAt: t1,
      hostVersion: '0.1.0',
      retainedUntil: new Date('2026-11-29T11:00:00.000Z').toISOString(),
    });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'runs', 'list']);
    });

    // Assert
    expect(out).toContain('RUN_ID');
    expect(out).toContain('aaaaaaaa');
    expect(out).toContain('bbbbbbbb');
    // Newest first
    const idxB = out.indexOf('bbbbbbbb');
    const idxA = out.indexOf('aaaaaaaa');
    expect(idxB).toBeLessThan(idxA);
  });

  it('list --json emits a JSON array of rows', async () => {
    // Arrange
    repo.insert({
      runId: 'cccccccc-1111-2222-3333-444444444444',
      startedAt: new Date('2026-06-01T10:00:00.000Z').toISOString(),
      hostVersion: '0.1.0',
      retainedUntil: new Date('2026-11-28T10:00:00.000Z').toISOString(),
    });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'runs', 'list', '--json']);
    });

    // Assert
    const parsed = JSON.parse(out) as Array<{ runId: string; hostVersion: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.runId).toBe('cccccccc-1111-2222-3333-444444444444');
  });

  it('list --since filters by started_at >= cutoff', async () => {
    // Arrange
    repo.insert({
      runId: 'old-run-1111111111111111',
      startedAt: '2026-05-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2026-10-28T00:00:00.000Z',
    });
    repo.insert({
      runId: 'new-run-1111111111111111',
      startedAt: '2026-06-15T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2026-12-12T00:00:00.000Z',
    });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync([
        'node',
        'dominus',
        'runs',
        'list',
        '--since',
        '2026-06-01T00:00:00.000Z',
      ]);
    });

    // Assert — runId column is truncated to 8 chars; JSON output would not be.
    const outJson = await captureStdout(async () => {
      await program.parseAsync([
        'node',
        'dominus',
        'runs',
        'list',
        '--since',
        '2026-06-01T00:00:00.000Z',
        '--json',
      ]);
    });
    expect(out).toContain('new-run-');
    expect(out).not.toContain('old-run-');
    const parsed = JSON.parse(outJson) as Array<{ runId: string }>;
    expect(parsed.map((r) => r.runId)).toEqual(['new-run-1111111111111111']);
  });

  it('show <runId> prints the full detail', async () => {
    // Arrange
    repo.insert({
      runId: 'show-run-111111111111111',
      startedAt: '2026-06-01T10:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2026-11-28T10:00:00.000Z',
    });
    repo.complete('show-run-111111111111111', {
      finishedAt: '2026-06-01T10:00:01.000Z',
      totalDurationMs: 1000,
      stageSummary: { ScoringStage: { passed: 2, filtered: 1, durationMs: 8 } },
      resultsSummary: {
        candidatesEvaluated: 3,
        recommended: 2,
        trademarkBlocked: 0,
        unscored: 1,
        errors: 0,
      },
    });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'runs', 'show', 'show-run-111111111111111']);
    });

    // Assert
    expect(out).toContain('Run:           show-run-111111111111111');
    expect(out).toContain('Duration:      1000 ms');
    expect(out).toContain('ScoringStage');
  });

  it('show <runId> with unknown id writes to stderr and exits 1', async () => {
    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await program.parseAsync(['node', 'dominus', 'runs', 'show', 'nope']);
      } catch (e) {
        // expected
        void e;
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });
    expect(err).toContain('No pipeline run with id nope');
  });

  it('prune deletes expired runs and reports a count', async () => {
    // Arrange
    repo.insert({
      runId: 'expired-11111111111111111',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z', // in the past
    });
    repo.insert({
      runId: 'kept-1111111111111111111',
      startedAt: new Date().toISOString(),
      hostVersion: '0.1.0',
      retainedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'runs', 'prune']);
    });

    // Assert
    expect(out).toMatch(/Pruned \d+ pipeline run\(s\)\. \d+ row\(s\) remain\./);
    expect(repo.findById('expired-11111111111111111')).toBeNull();
    expect(repo.findById('kept-1111111111111111111')).not.toBeNull();
  });

  it('prune --dry-run does not delete', async () => {
    // Arrange
    repo.insert({
      runId: 'expired-22222222222222222',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'runs', 'prune', '--dry-run']);
    });

    // Assert
    expect(out).toContain('Would prune');
    expect(repo.findById('expired-22222222222222222')).not.toBeNull();
  });

  it('wait without runsRepo prints error and exits', async () => {
    const noRepoProgram = new Command();
    registerRunsCommand(noRepoProgram, { runsRepo: null as unknown as PipelineRunsRepository });

    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await noRepoProgram.parseAsync(['node', 'dominus', 'runs', 'wait', 'some-run-id']);
      } catch {
        // expected
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });

    expect(err).toContain('PipelineRunsRepository not available');
  });
});
