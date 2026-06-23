import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { registerOutcomeCommand } from '../commands/outcome-command.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

async function seedPortfolio(provider: SqliteProvider, domain: string): Promise<void> {
  await new PortfolioRepository(provider).insert({
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-12-31T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
  });
}

type Spy = { mock: { calls: unknown[][] }; mockClear(): void; mockRestore(): void };
let stdoutSpy: Spy | undefined;
let stderrSpy: Spy | undefined;
let exitSpy: Spy | undefined;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write') as unknown as Spy;
  stdoutSpy.mockClear();
  stderrSpy = vi.spyOn(process.stderr, 'write') as unknown as Spy;
  stderrSpy.mockClear();
  exitSpy = vi.spyOn(process, 'exit') as unknown as Spy;
  exitSpy.mockClear();
});

afterEach(() => {
  stdoutSpy?.mockRestore();
  stderrSpy?.mockRestore();
  exitSpy?.mockRestore();
});

function stdoutText(): string {
  return (stdoutSpy?.mock.calls ?? []).map((c) => String(c[0])).join('');
}

function stderrText(): string {
  return (stderrSpy?.mock.calls ?? []).map((c) => String(c[0])).join('');
}

describe('registerOutcomeCommand', () => {
  describe('record', () => {
    it('records a sold outcome and prints the result', async () => {
      const provider = openTestDb();
      await seedPortfolio(provider, 'alpha.com');
      const repo = new OutcomeRepository(provider);
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program.parseAsync([
        'node',
        'cli',
        'outcome',
        'record',
        '--domain',
        'alpha.com',
        '--type',
        'sold',
        '--occurred-at',
        '2026-04-15',
        '--sale-price',
        '1500',
        '--venue',
        'sedo',
        '--days-listed',
        '240',
      ]);

      const stored = await repo.findByDomain('alpha.com');
      expect(stored).toHaveLength(1);
      expect(stored[0]?.type).toBe('sold');
      expect(stored[0]?.salePriceEur).toBe(1500);
      expect(stdoutText()).toMatch(/Recorded outcome/);
    });

    it('rejects an unknown type with exit 1', async () => {
      const provider = openTestDb();
      await seedPortfolio(provider, 'alpha.com');
      const repo = new OutcomeRepository(provider);
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program
        .parseAsync([
          'node',
          'cli',
          'outcome',
          'record',
          '--domain',
          'alpha.com',
          '--type',
          'parachuted',
          '--occurred-at',
          '2026-04-15',
        ])
        .catch(() => undefined);

      expect(stderrText()).toMatch(/invalid outcome type/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects an unparseable --occurred-at with exit 1', async () => {
      const provider = openTestDb();
      await seedPortfolio(provider, 'alpha.com');
      const repo = new OutcomeRepository(provider);
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program
        .parseAsync([
          'node',
          'cli',
          'outcome',
          'record',
          '--domain',
          'alpha.com',
          '--type',
          'sold',
          '--occurred-at',
          'not-a-date',
        ])
        .catch(() => undefined);

      expect(stderrText()).toMatch(/invalid --occurred-at/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails clearly when the domain is not in the portfolio', async () => {
      const provider = openTestDb();
      const repo = new OutcomeRepository(provider);
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program
        .parseAsync([
          'node',
          'cli',
          'outcome',
          'record',
          '--domain',
          'ghost.com',
          '--type',
          'sold',
          '--occurred-at',
          '2026-04-15',
        ])
        .catch(() => undefined);

      expect(stderrText()).toMatch(/not found in portfolio/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('list', () => {
    it('lists all outcomes when no filter is given', async () => {
      const provider = openTestDb();
      await seedPortfolio(provider, 'alpha.com');
      await seedPortfolio(provider, 'beta.io');
      const repo = new OutcomeRepository(provider);
      await repo.insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-04-15T00:00:00.000Z',
        salePriceEur: 1000,
      });
      await repo.insert({
        domain: 'beta.io',
        type: 'renewed',
        occurredAt: '2026-05-15T00:00:00.000Z',
      });
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program.parseAsync(['node', 'cli', 'outcome', 'list']);

      const out = stdoutText();
      expect(out).toMatch(/alpha\.com/);
      expect(out).toMatch(/beta\.io/);
    });

    it('filters by domain', async () => {
      const provider = openTestDb();
      await seedPortfolio(provider, 'alpha.com');
      await seedPortfolio(provider, 'beta.io');
      const repo = new OutcomeRepository(provider);
      await repo.insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
      await repo.insert({
        domain: 'beta.io',
        type: 'renewed',
        occurredAt: '2026-05-15T00:00:00.000Z',
      });
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program.parseAsync(['node', 'cli', 'outcome', 'list', '--domain', 'alpha.com']);

      const out = stdoutText();
      expect(out).toMatch(/alpha\.com/);
      expect(out).not.toMatch(/beta\.io/);
    });

    it('filters by type', async () => {
      const provider = openTestDb();
      await seedPortfolio(provider, 'alpha.com');
      await seedPortfolio(provider, 'beta.io');
      const repo = new OutcomeRepository(provider);
      await repo.insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
      await repo.insert({
        domain: 'beta.io',
        type: 'renewed',
        occurredAt: '2026-05-15T00:00:00.000Z',
      });
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program.parseAsync(['node', 'cli', 'outcome', 'list', '--type', 'sold']);

      const out = stdoutText();
      expect(out).toMatch(/sold/);
      expect(out).not.toMatch(/renewed/);
    });

    it('prints a friendly message when no outcomes exist', async () => {
      const provider = openTestDb();
      const repo = new OutcomeRepository(provider);
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program.parseAsync(['node', 'cli', 'outcome', 'list']);

      expect(stdoutText()).toMatch(/No outcomes recorded/);
    });
  });

  describe('stats', () => {
    it('prints the aggregate counts and realised revenue for a domain', async () => {
      const provider = openTestDb();
      await seedPortfolio(provider, 'alpha.com');
      const repo = new OutcomeRepository(provider);
      await repo.insert({
        domain: 'alpha.com',
        type: 'renewed',
        occurredAt: '2025-12-01T00:00:00.000Z',
      });
      await await repo.insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-04-01T00:00:00.000Z',
        salePriceEur: 800,
      });
      await repo.insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-05-01T00:00:00.000Z',
        salePriceEur: 1200,
      });
      const program = new Command();
      program.exitOverride();
      registerOutcomeCommand(program, repo);

      await program.parseAsync(['node', 'cli', 'outcome', 'stats', '--domain', 'alpha.com']);

      const out = stdoutText();
      expect(out).toMatch(/sold:\s+2/);
      expect(out).toMatch(/renewed:\s+1/);
      expect(out).toMatch(/total realised: €2000/);
    });
  });
});
