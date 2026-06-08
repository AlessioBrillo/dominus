import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { TrademarkRepository } from '../../db/repositories/trademark-repository.js';
import { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import { registerMaintenanceCommand } from '../commands/maintenance-command.js';
import { Command } from 'commander';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function buildProgram(db: Database.Database): {
  program: Command;
  tmRepo: TrademarkRepository;
  runsRepo: PipelineRunsRepository;
} {
  const tmRepo = new TrademarkRepository(db);
  const runsRepo = new PipelineRunsRepository(db);
  const program = new Command();
  registerMaintenanceCommand(program, { db, trademarkRepo: tmRepo, runsRepo });
  return { program, tmRepo, runsRepo };
}

function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = original;
  }).then((): string => buffer);
}

function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  return Promise.resolve(fn()).finally(() => {
    process.stderr.write = original;
  }).then((): string => buffer);
}

describe('CLI: dominus maintenance', () => {
  let db: Database.Database;
  let tmRepo: TrademarkRepository;
  let runsRepo: PipelineRunsRepository;
  let program: Command;

  beforeEach(() => {
    db = openTestDb();
    ({ program, tmRepo, runsRepo } = buildProgram(db));
  });

  it('prune with no flags prunes both trademark_results and pipeline_runs', async () => {
    // Arrange
    tmRepo.insertByTerm('alpha', 'USPTO', false, [], { hits: [] }, 7);
    tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1); // already expired
    runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = tmRepo.count();
    const runsBefore = runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune']);
    });

    // Assert
    expect(out).toMatch(/Pruned 1 trademark_results row\(s\)/);
    expect(out).toMatch(/Pruned 1 pipeline_runs row\(s\)/);
    expect(tmRepo.count()).toBe(tmBefore - 1);
    expect(runsRepo.count()).toBe(runsBefore - 1);
  });

  it('prune --cache-only leaves pipeline_runs alone', async () => {
    // Arrange
    tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1);
    runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = tmRepo.count();
    const runsBefore = runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune', '--cache-only']);
    });

    // Assert
    expect(out).toMatch(/Pruned 1 trademark_results row\(s\)/);
    expect(out).not.toMatch(/pipeline_runs/);
    expect(tmRepo.count()).toBe(tmBefore - 1);
    expect(runsRepo.count()).toBe(runsBefore);
  });

  it('prune --runs-only leaves trademark_results alone', async () => {
    // Arrange
    tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1);
    runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = tmRepo.count();
    const runsBefore = runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune', '--runs-only']);
    });

    // Assert
    expect(out).not.toMatch(/trademark_results/);
    expect(out).toMatch(/Pruned 1 pipeline_runs row\(s\)/);
    expect(tmRepo.count()).toBe(tmBefore);
    expect(runsRepo.count()).toBe(runsBefore - 1);
  });

  it('prune --dry-run does not delete', async () => {
    // Arrange
    tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1);
    runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = tmRepo.count();
    const runsBefore = runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune', '--dry-run']);
    });

    // Assert
    expect(out).toMatch(/Would prune/);
    expect(tmRepo.count()).toBe(tmBefore);
    expect(runsRepo.count()).toBe(runsBefore);
  });

  it('rejects mutually exclusive --cache-only and --runs-only', async () => {
    // Act
    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await program.parseAsync(['node', 'dominus', 'maintenance', 'prune', '--cache-only', '--runs-only']);
      } catch (e) {
        void e;
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });
    expect(err).toMatch(/--cache-only and --runs-only are mutually exclusive/);
  });
});
