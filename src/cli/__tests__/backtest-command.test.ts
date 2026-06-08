import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { BacktestSignalsRepository } from '../../db/repositories/backtest-signals-repository.js';
import { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import { CandidateSource, CandidateStatus } from '../../types/candidate.js';
import type { ScoreResult } from '../../types/score.js';
import { registerBacktestCommand } from '../commands/backtest-command.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedPortfolio(db: Database.Database, domain: string): void {
  new PortfolioRepository(db).insert({
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
  });
}

function seedScoringSnapshot(
  db: Database.Database,
  domain: string,
  scoredAt: string,
  expectedValue: number,
  buyMax: number,
  listPrice: number,
  confidence: number,
): void {
  const candidateRepo = new CandidateRepository(db);
  const scoringRepo = new ScoringRepository(db);
  const existing = candidateRepo.findByDomain(domain);
  const candidate =
    existing ??
    candidateRepo.insert({
      domain,
      tld: '.com',
      source: CandidateSource.KeywordCombo,
      status: CandidateStatus.Recommended,
      isPremium: false,
      pipelineRunId: 'test',
    });

  const result: ScoreResult = {
    domain,
    expectedValue,
    confidence,
    suggestedBuyMax: buyMax,
    suggestedListPrice: listPrice,
    weightedScore: expectedValue / 1000,
    breakdown: {
      intrinsic: { score: 0.5, weight: 0.3, details: {} },
      commercial: { score: 0.5, weight: 0.35, details: {} },
      market: { score: 0.5, weight: 0.25, details: {} },
      expiry: { score: 0, weight: 0.1, details: {} },
    },
    recommended: true,
    scoredAt,
  };
  scoringRepo.insert(candidate.id!, 'test', result);
  db.prepare(
    'UPDATE scoring_runs SET scored_at = ? WHERE candidate_id = ? ORDER BY id DESC LIMIT 1',
  ).run(scoredAt, candidate.id);
}

function seedSoldOutcome(
  db: Database.Database,
  domain: string,
  salePrice: number,
  occurredAt: string,
): void {
  new OutcomeRepository(db).insert({
    domain,
    type: 'sold',
    occurredAt,
    salePriceEur: salePrice,
  });
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
    chunks.push(String(data));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('dominus backtest CLI', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  it('snapshot subcommand rebuilds the backtest_signals table', async () => {
    seedPortfolio(db, 'alpha.com');
    seedScoringSnapshot(db, 'alpha.com', '2025-12-01T00:00:00.000Z', 1000, 500, 3000, 0.7);
    seedSoldOutcome(db, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

    const out = await captureStdout(async () => {
      const program = new Command();
      program.exitOverride();
      const outcomeRepo = new OutcomeRepository(db);
      registerBacktestCommand(program, { db, outcomeRepo });
      try {
        await program.parseAsync(['node', 'dominus', 'backtest', 'snapshot']);
      } catch {
        // exitOverride throws after the action runs
      }
    });

    expect(out).toContain('scanned 1');
    expect(out).toContain('inserted 1');
    expect(out).toContain('skipped 0');
    expect(new BacktestSignalsRepository(db).count()).toBe(1);
  });

  it('report subcommand on empty data prints a clear "no data" message', async () => {
    const out = await captureStdout(async () => {
      const program = new Command();
      program.exitOverride();
      const outcomeRepo = new OutcomeRepository(db);
      registerBacktestCommand(program, { db, outcomeRepo });
      try {
        await program.parseAsync(['node', 'dominus', 'backtest', 'report']);
      } catch {
        // exitOverride throws after the action runs
      }
    });

    expect(out).toContain('0 sold outcomes');
    expect(out).toContain('Record at least one');
  });

  it('run subcommand performs snapshot + report in one call', async () => {
    seedPortfolio(db, 'alpha.com');
    seedPortfolio(db, 'beta.io');
    seedScoringSnapshot(db, 'alpha.com', '2025-12-01T00:00:00.000Z', 1000, 500, 3000, 0.7);
    seedScoringSnapshot(db, 'beta.io', '2025-12-01T00:00:00.000Z', 800, 400, 2400, 0.4);
    seedSoldOutcome(db, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');
    seedSoldOutcome(db, 'beta.io', 600, '2026-05-01T00:00:00.000Z');

    const out = await captureStdout(async () => {
      const program = new Command();
      program.exitOverride();
      const outcomeRepo = new OutcomeRepository(db);
      registerBacktestCommand(program, { db, outcomeRepo });
      try {
        await program.parseAsync(['node', 'dominus', 'backtest', 'run']);
      } catch {
        // exitOverride throws after the action runs
      }
    });

    expect(out).toContain('Snapshot: scanned 2');
    expect(out).toContain('Sample: 2 sold');
    expect(out).toContain('MAE');
    expect(out).toContain('Buy-max accuracy');
    expect(out).toContain('Confidence calibration');
  });

  it('run --json emits valid JSON with the report', async () => {
    seedPortfolio(db, 'alpha.com');
    seedScoringSnapshot(db, 'alpha.com', '2025-12-01T00:00:00.000Z', 1000, 500, 3000, 0.7);
    seedSoldOutcome(db, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

    const out = await captureStdout(async () => {
      const program = new Command();
      program.exitOverride();
      const outcomeRepo = new OutcomeRepository(db);
      registerBacktestCommand(program, { db, outcomeRepo });
      try {
        await program.parseAsync(['node', 'dominus', 'backtest', 'run', '--json']);
      } catch {
        // exitOverride throws after the action runs
      }
    });

    const parsed = JSON.parse(out) as { report: { sampleSize: number } };
    expect(parsed.report.sampleSize).toBe(1);
  });

  it('run --no-snapshot reports on the existing table without rebuilding', async () => {
    seedPortfolio(db, 'alpha.com');
    seedScoringSnapshot(db, 'alpha.com', '2025-12-01T00:00:00.000Z', 1000, 500, 3000, 0.7);
    seedSoldOutcome(db, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

    // Pre-snapshot once to populate the table
    await captureStdout(async () => {
      const program = new Command();
      program.exitOverride();
      const outcomeRepo = new OutcomeRepository(db);
      registerBacktestCommand(program, { db, outcomeRepo });
      try {
        await program.parseAsync(['node', 'dominus', 'backtest', 'snapshot']);
      } catch {
        // exitOverride throws after the action runs
      }
    });

    const out = await captureStdout(async () => {
      const program = new Command();
      program.exitOverride();
      const outcomeRepo = new OutcomeRepository(db);
      registerBacktestCommand(program, { db, outcomeRepo });
      try {
        await program.parseAsync(['node', 'dominus', 'backtest', 'run', '--no-snapshot']);
      } catch {
        // exitOverride throws after the action runs
      }
    });

    expect(out).not.toContain('Snapshot: scanned');
    expect(out).toContain('Sample: 1 sold');
  });

  it('suggest-weights subcommand holds all signals on a small sample', async () => {
    seedPortfolio(db, 'alpha.com');
    seedScoringSnapshot(db, 'alpha.com', '2025-12-01T00:00:00.000Z', 1000, 500, 3000, 0.7);
    seedSoldOutcome(db, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

    const out = await captureStdout(async () => {
      const program = new Command();
      program.exitOverride();
      const outcomeRepo = new OutcomeRepository(db);
      registerBacktestCommand(program, { db, outcomeRepo });
      try {
        await program.parseAsync(['node', 'dominus', 'backtest', 'suggest-weights']);
      } catch {
        // exitOverride throws after the action runs
      }
    });

    expect(out).toContain('DOMINUS weight suggester');
    expect(out).toMatch(/below the 5 minimum/);
  });
});
