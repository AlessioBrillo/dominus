// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The CLI in PostgreSQL mode.
//
// The Cloud edition runs on PostgreSQL, where there is no better-sqlite3
// handle at all. The backtest and the maintenance commands used to check
// for that handle while the command line was being BUILT, and the check
// called process.exit(1): in Cloud mode the whole CLI died before a
// single command could run — including `dominus keys create`, the
// documented way to mint the first API key of a fresh deployment, and
// `dominus scheduler run`.
//
// These tests are the regression guard: a command that cannot run in
// this deployment must refuse at invocation, not take the other
// commands down with it.
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerBacktestCommand } from '../commands/backtest-command.js';
import { registerMaintenanceCommand } from '../commands/maintenance-command.js';
import { registerHealthCommand } from '../commands/health-command.js';
import type { DatabaseProvider } from '../../db/provider/interface.js';

function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    buffer += s;
    return true;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        () => {
          process.stderr.write = original;
          return buffer;
        },
        () => {
          process.stderr.write = original;
          return buffer;
        },
      );
    }
    process.stderr.write = original;
    return Promise.resolve(buffer);
  } catch {
    process.stderr.write = original;
    return Promise.resolve(buffer);
  }
}

/** Runs an action and reports the exit code it tried to use. */
async function runExpectingExit(
  program: Command,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  const origExit = process.exit;
  let code = 0;
  (process as unknown as { exit: (c: number) => never }).exit = ((c: number) => {
    code = c;
    throw new Error(`__exit:${c}`);
  }) as never;
  const stderr = await captureStderr(async () => {
    try {
      await program.parseAsync(['node', 'dominus', ...args]);
    } catch (e) {
      void e;
    } finally {
      (process as unknown as { exit: (c: number) => never }).exit = origExit;
    }
  });
  return { code, stderr };
}

describe('the CLI in PostgreSQL mode (the Cloud edition)', () => {
  it('builds the whole command line without exiting', () => {
    // The registration used to call process.exit(1) here.
    const program = new Command();
    expect(() => {
      registerBacktestCommand(program, {
        db: null,
        outcomeRepo: {} as never,
        currentWeights: undefined,
      });
      registerMaintenanceCommand(program, {
        db: null,
        trademarkRepo: {} as never,
        runsRepo: {} as never,
        candidateRepo: {} as never,
        scoringRepo: {} as never,
      });
    }).not.toThrow();
  });

  it('refuses the backtest at invocation, with a message that names the command', async () => {
    const program = new Command();
    registerBacktestCommand(program, {
      db: null,
      outcomeRepo: {} as never,
      currentWeights: undefined,
    });
    const { code, stderr } = await runExpectingExit(program, ['backtest', 'run']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/requires a SQLite database/);
    expect(stderr).toMatch(/backtest run/);
  });

  it('refuses the maintenance backup at invocation', async () => {
    const program = new Command();
    registerMaintenanceCommand(program, {
      db: null,
      trademarkRepo: {} as never,
      runsRepo: {} as never,
      candidateRepo: {} as never,
      scoringRepo: {} as never,
    });
    const { code, stderr } = await runExpectingExit(program, ['maintenance', 'backup']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/requires a SQLite database/);
  });

  it('reports the PostgreSQL connection in the health check instead of crashing', async () => {
    const program = new Command();
    const provider = { isOpen: () => true } as unknown as DatabaseProvider;
    registerHealthCommand(program, {
      db: null,
      config: { KEYWORD_PROVIDER: 'none', TM_PROVIDER: 'none' } as never,
      provider,
    });

    const original = process.stdout.write.bind(process.stdout);
    let buffer = '';
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ): boolean => {
      buffer += s;
      return true;
    };
    try {
      await program.parseAsync(['node', 'dominus', 'health', '--json']);
    } finally {
      process.stdout.write = original;
    }

    const report = JSON.parse(buffer) as {
      status: string;
      database: string;
      databaseEngine: string;
    };
    expect(report.databaseEngine).toBe('postgresql');
    expect(report.database).toBe('connected');
    expect(report.status).toBe('ok');
  });
});
