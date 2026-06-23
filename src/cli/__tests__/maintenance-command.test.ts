import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { TrademarkRepository } from '../../db/repositories/trademark-repository.js';
import { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import { registerMaintenanceCommand } from '../commands/maintenance-command.js';
import { Command } from 'commander';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function buildProgram(provider: SqliteProvider): {
  program: Command;
  tmRepo: TrademarkRepository;
  runsRepo: PipelineRunsRepository;
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
} {
  const tmRepo = new TrademarkRepository(provider);
  const runsRepo = new PipelineRunsRepository(provider);
  const candidateRepo = new CandidateRepository(provider);
  const scoringRepo = new ScoringRepository(provider);
  const program = new Command();
  registerMaintenanceCommand(program, {
    db: provider.rawDb,
    trademarkRepo: tmRepo,
    runsRepo,
    candidateRepo,
    scoringRepo,
  });
  return { program, tmRepo, runsRepo, candidateRepo, scoringRepo };
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

describe('CLI: dominus maintenance', () => {
  let provider: SqliteProvider;
  let tmRepo: TrademarkRepository;
  let runsRepo: PipelineRunsRepository;
  let program: Command;

  beforeEach(() => {
    provider = openTestDb();
    ({ program, tmRepo, runsRepo } = buildProgram(provider));
  });

  it('prune with no flags prunes both trademark_results and pipeline_runs', async () => {
    // Arrange
    await tmRepo.insertByTerm('alpha', 'USPTO', false, [], { hits: [] }, 7);
    await tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1); // already expired
    await runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = await tmRepo.count();
    const runsBefore = await runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune']);
    });

    // Assert
    expect(out).toMatch(/Pruned 1 trademark_results row\(s\)/);
    expect(out).toMatch(/Pruned 1 pipeline_runs row\(s\)/);
    expect(await tmRepo.count()).toBe(tmBefore - 1);
    expect(await runsRepo.count()).toBe(runsBefore - 1);
  });

  it('prune --cache-only leaves pipeline_runs alone', async () => {
    // Arrange
    await tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1);
    await runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = await tmRepo.count();
    const runsBefore = await runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune', '--cache-only']);
    });

    // Assert
    expect(out).toMatch(/Pruned 1 trademark_results row\(s\)/);
    expect(out).not.toMatch(/pipeline_runs/);
    expect(await tmRepo.count()).toBe(tmBefore - 1);
    expect(await runsRepo.count()).toBe(runsBefore);
  });

  it('prune --runs-only leaves trademark_results alone', async () => {
    // Arrange
    await tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1);
    await runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = await tmRepo.count();
    const runsBefore = await runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune', '--runs-only']);
    });

    // Assert
    expect(out).not.toMatch(/trademark_results/);
    expect(out).toMatch(/Pruned 1 pipeline_runs row\(s\)/);
    expect(await tmRepo.count()).toBe(tmBefore);
    expect(await runsRepo.count()).toBe(runsBefore - 1);
  });

  it('prune --dry-run does not delete', async () => {
    // Arrange
    await tmRepo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1);
    await runsRepo.insert({
      runId: 'r-expired',
      startedAt: '2025-01-01T00:00:00.000Z',
      hostVersion: '0.1.0',
      retainedUntil: '2025-06-30T00:00:00.000Z',
    });
    const tmBefore = await tmRepo.count();
    const runsBefore = await runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'maintenance', 'prune', '--dry-run']);
    });

    // Assert
    expect(out).toMatch(/Would prune/);
    expect(await tmRepo.count()).toBe(tmBefore);
    expect(await runsRepo.count()).toBe(runsBefore);
  });

  it('prune --before removes runs started before N days ago', async () => {
    // Arrange
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // 200 days ago
    await runsRepo.insert({
      runId: 'r-old',
      startedAt: oldDate,
      hostVersion: '0.1.0',
      retainedUntil: '2099-01-01T00:00:00.000Z',
    });
    await runsRepo.insert({
      runId: 'r-new',
      startedAt: new Date().toISOString(),
      hostVersion: '0.1.0',
      retainedUntil: '2099-01-01T00:00:00.000Z',
    });
    const before = await runsRepo.count();

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync([
        'node',
        'dominus',
        'maintenance',
        'prune',
        '--runs-only',
        '--before',
        '180',
      ]);
    });

    // Assert
    expect(out).toMatch(/Pruned 1 pipeline_runs row\(s\) started before/);
    expect(await runsRepo.count()).toBe(before - 1);
    expect(await runsRepo.findById('r-old')).toBeNull();
  });

  it('prune --before --dry-run does not delete', async () => {
    // Arrange
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    await runsRepo.insert({
      runId: 'r-old',
      startedAt: oldDate,
      hostVersion: '0.1.0',
      retainedUntil: '2099-01-01T00:00:00.000Z',
    });

    // Act
    const out = await captureStdout(async () => {
      await program.parseAsync([
        'node',
        'dominus',
        'maintenance',
        'prune',
        '--runs-only',
        '--before',
        '180',
        '--dry-run',
      ]);
    });

    // Assert
    expect(out).toMatch(/Would prune/);
    expect(await runsRepo.findById('r-old')).not.toBeNull();
  });

  it('rejects mutually exclusive --cache-only and --runs-only', async () => {
    // Act
    const err = await captureStderr(async () => {
      const origExit = process.exit;
      (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
        throw new Error(`__exit:${code}`);
      }) as never;
      try {
        await program.parseAsync([
          'node',
          'dominus',
          'maintenance',
          'prune',
          '--cache-only',
          '--runs-only',
        ]);
      } catch (e) {
        void e;
      } finally {
        (process as unknown as { exit: (code: number) => never }).exit = origExit;
      }
    });
    expect(err).toMatch(/--cache-only and --runs-only are mutually exclusive/);
  });
});
