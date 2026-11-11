// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for `dominus doctor`.
 *
 * The command must behave correctly when installed as an ESM artifact:
 * - report its own version (not 0.0.0) regardless of cwd,
 * - report "database not initialized" instead of crashing with a raw
 *   SQLite stack trace when there is no database,
 * - resolve paths relative to the module, not cwd.
 *
 * `vi.mock` calls are hoisted to module scope by vitest, so the mocks for
 * `node:fs` and `node:child_process` are in place before the module under
 * test is dynamically imported in each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import type { Config } from '../../../config.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ name: 'dominus-oss', version: '1.5.2' })),
  readdirSync: vi.fn(() => ['pre-migration-1793830829185.db']),
  statSync: vi.fn((): { isFile: () => boolean; mtime: Date } => ({
    isFile: () => true,
    mtime: new Date(Date.now() - 1000 * 60 * 30),
  })),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(
    (): string => `
Score: nike.com
  Recommended:       NO (TM blocked)
Score: vintagecoffee.com
  Recommended:       YES (TM clear)
`,
  ),
  execSync: vi.fn((cmd: string): string => {
    if (cmd.includes('fsutil')) {
      return 'Volume label: C:\nFree bytes   : 107374182400\nTotal bytes  : 214748364800\nTotal free bytes : 107374182400\n';
    }
    // The command is `df -P / | tail -1`: ONE line, the data row. The
    // header line must not be in the mock: the probe reads the fourth
    // column of the line it gets, and a two-line mock made the check
    // read the word "Available" as a number (NaN) on Linux.
    return '/dev/sda1       104857600 20971520 83886080  20% /\n';
  }),
}));

let capturedStdout = '';

function captureProcess(): void {
  capturedStdout = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (
    _s: string,
  ): boolean => {
    capturedStdout += _s;
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (
    _s: string,
  ): boolean => {
    return true;
  };
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`__exit:${code ?? -1}`);
  }) as never;
}

function restoreProcess(): void {
  (process.stdout as unknown as { write: (s: string) => boolean }).write =
    process.stdout.write.bind(process.stdout);
  (process.stderr as unknown as { write: (s: string) => boolean }).write =
    process.stderr.write.bind(process.stderr);
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never => {
    void code;
    throw new Error('process.exit called outside test');
  };
}

function parseDoctorOutput(out: string): {
  version: string;
  checks: Array<{ name: string; status: string; detail: string }>;
  ok: boolean;
} {
  const jsonStart = out.indexOf('{');
  const jsonEnd = out.lastIndexOf('}') + 1;
  return JSON.parse(out.slice(jsonStart, jsonEnd));
}

async function runDoctor(configOverrides: Partial<Config> = {}): Promise<void> {
  const { registerDoctorCommand } = await import('../doctor-command.js');
  const program = new Command();
  program.name('dominus');
  program.version('1.5.2');
  registerDoctorCommand(program, {
    config: {
      DATABASE_URL: undefined,
      DATABASE_PATH: './data/dominus.db',
      BACKUP_DIR: './data/backup',
      DNS_UNBOUND_ENABLED: true,
      API_KEYS: undefined,
      ...configOverrides,
    } as unknown as Config,
    db: null,
  });
  await program.parseAsync(['node', 'dominus', 'doctor', '--json']);
}

describe('CLI: dominus doctor', () => {
  beforeEach(() => {
    captureProcess();
    vi.resetModules();
  });

  afterEach(() => {
    restoreProcess();
  });

  it('reports its own version, not 0.0.0', async () => {
    try {
      await runDoctor();
    } catch {
      // process.exit is mocked to throw
    }
    const parsed = parseDoctorOutput(capturedStdout);
    expect(parsed.version).toBe('1.5.2');
    expect(parsed.version).not.toBe('0.0.0');
  });

  it('reports database not initialized as a fail check instead of crashing', async () => {
    try {
      await runDoctor({ DATABASE_URL: undefined });
    } catch {
      // process.exit is mocked to throw
    }
    const parsed = parseDoctorOutput(capturedStdout);
    const integrity = parsed.checks.find((c) => c.name === 'database integrity');
    expect(integrity?.status).toBe('fail');
    expect(integrity?.detail).toContain('not initialized');
    expect(parsed.ok).toBe(false);
  });

  it('reports cloud mode database integrity as ok', async () => {
    try {
      await runDoctor({ DATABASE_URL: 'postgresql://user@host:5432/db' });
    } catch {
      // process.exit is mocked to throw
    }
    const parsed = parseDoctorOutput(capturedStdout);
    const mode = parsed.checks.find((c) => c.name === 'mode');
    expect(mode?.detail).toBe('cloud (PostgreSQL)');
    const integrity = parsed.checks.find((c) => c.name === 'database integrity');
    expect(integrity?.status).toBe('ok');
    expect(integrity?.detail).toBe('not a SQLite connection (cloud mode)');
  });

  it('reports trademark canary green', async () => {
    try {
      await runDoctor();
    } catch {
      // process.exit is mocked to throw
    }
    const parsed = parseDoctorOutput(capturedStdout);
    const canary = parsed.checks.find((c) => c.name === 'trademark canary');
    expect(canary?.status).toBe('ok');
    expect(canary?.detail).toContain('blocked');
    expect(canary?.detail).toContain('clear');
  });

  it('reports backup age as ok when a recent backup exists', async () => {
    try {
      await runDoctor({ BACKUP_DIR: './data/backup' });
    } catch {
      // process.exit is mocked to throw
    }
    const parsed = parseDoctorOutput(capturedStdout);
    const backup = parsed.checks.find((c) => c.name === 'backup age');
    expect(backup?.status).toBe('ok');
  });

  it('reports disk space as ok when free space exceeds 1 GB', async () => {
    try {
      await runDoctor();
    } catch {
      // process.exit is mocked to throw
    }
    const parsed = parseDoctorOutput(capturedStdout);
    const disk = parsed.checks.find((c) => c.name === 'disk space');
    expect(disk?.status).toBe('ok');
    expect(disk?.detail).toContain('GB free');
  });
});
