import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { RenewalAlertRepository } from '../../db/repositories/renewal-alert-repository.js';
import { registerPortfolioCommand } from '../commands/portfolio-command.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';

function createTestDeps(): { alertRepo: RenewalAlertRepository } {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);

  const portfolioRepo = new PortfolioRepository(provider);
  const alertRepo = new RenewalAlertRepository(provider);

  portfolioRepo.insert({
    domain: 'example.com',
    tld: 'com',
    acquiredAt: '2025-01-01',
    renewalDate: '2026-07-01',
    acquisitionCost: 10,
    renewalCost: 15,
    registrar: 'test',
  });

  alertRepo.upsert(
    {
      domain: 'example.com',
      portfolioEntryId: 1,
      alertType: AlertType.RenewalImminent,
      severity: AlertSeverity.Warning,
      message: 'Domain renews in 25 days',
    },
    ['console'],
  );

  return { alertRepo };
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

describe('portfolio alerts list', () => {
  it('lists alerts in table format', async () => {
    const { alertRepo } = createTestDeps();
    const program = new Command();
    program.exitOverride();
    const manager = { list: vi.fn().mockReturnValue([]) } as never;
    registerPortfolioCommand(program, { manager, alertRepo });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'portfolio', 'alerts', 'list']);
    });
    expect(out).toContain('example.com');
    expect(out).toContain('renewal_imminent');
  });

  it('lists alerts in JSON format', async () => {
    const { alertRepo } = createTestDeps();
    const program = new Command();
    program.exitOverride();
    const manager = { list: vi.fn().mockReturnValue([]) } as never;
    registerPortfolioCommand(program, { manager, alertRepo });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'portfolio', 'alerts', 'list', '--json']);
    });
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('shows empty message when no alerts', async () => {
    const { alertRepo } = createTestDeps();
    alertRepo.acknowledgeAll();
    const program = new Command();
    program.exitOverride();
    const manager = { list: vi.fn().mockReturnValue([]) } as never;
    registerPortfolioCommand(program, { manager, alertRepo });

    const out = await captureStdout(async () => {
      await program.parseAsync([
        'node',
        'dominus',
        'portfolio',
        'alerts',
        'list',
        '--unacknowledged',
      ]);
    });
    expect(out).toContain('No alerts found');
  });
});

describe('portfolio alerts acknowledge', () => {
  it('acknowledges by id', async () => {
    const { alertRepo } = createTestDeps();
    const program = new Command();
    program.exitOverride();
    const manager = { list: vi.fn().mockReturnValue([]) } as never;
    registerPortfolioCommand(program, { manager, alertRepo });

    const out = await captureStdout(async () => {
      await program.parseAsync([
        'node',
        'dominus',
        'portfolio',
        'alerts',
        'acknowledge',
        '--id',
        '1',
      ]);
    });
    expect(out).toContain('Alert 1 acknowledged');
  });

  it('acknowledges all', async () => {
    const { alertRepo } = createTestDeps();
    const program = new Command();
    program.exitOverride();
    const manager = { list: vi.fn().mockReturnValue([]) } as never;
    registerPortfolioCommand(program, { manager, alertRepo });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'portfolio', 'alerts', 'acknowledge', '--all']);
    });
    expect(out).toContain('alert(s) acknowledged');
  });
});

describe('portfolio alerts run', () => {
  it('runs the alert engine', async () => {
    const { alertRepo } = createTestDeps();
    const alertEngine = {
      checkAll: vi.fn().mockResolvedValue({ generated: 2, alerts: [] }),
    } as unknown as RenewalAlertEngine;
    const program = new Command();
    program.exitOverride();
    const manager = { list: vi.fn().mockReturnValue([]) } as never;
    registerPortfolioCommand(program, { manager, alertRepo, alertEngine });

    const out = await captureStdout(async () => {
      await program.parseAsync(['node', 'dominus', 'portfolio', 'alerts', 'run']);
    });
    expect(out).toContain('Generated 2 alert(s)');
  });
});
