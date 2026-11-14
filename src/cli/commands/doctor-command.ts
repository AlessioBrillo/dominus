// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `dominus doctor` — pre-flight diagnosis for a self-hosted installation.
 *
 * Reports configuration, database integrity, schema vs. manifest, DNS mode,
 * trademark-gate canary, backup age and disk space. Human-readable by
 * default; `--json` emits a single JSON object for operators and
 * monitoring.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Command } from 'commander';
import type { Config } from '../../config.js';
import { readAppliedMigrations } from '../../db/migration-manifest.js';
import { getMigrationManifest } from '../../db/migration-manifest.js';
import { createSqliteProvider } from '../../db/index.js';
import { execFileSync, execSync } from 'node:child_process';

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorResult {
  version: string;
  checks: DoctorCheck[];
  ok: boolean;
}

export function registerDoctorCommand(
  program: Command,
  deps: { config: Config; db: Database.Database | null },
): void {
  program
    .command('doctor')
    .description(
      'Diagnose the installation: config, DB, schema, DNS, trademark canary, backups, disk',
    )
    .option('--json', 'Emit JSON instead of a human-readable report', false)
    .option('--skip-trademark', 'Skip the live trademark-gate canary (for smoke tests)', false)
    .action(async (options: { json: boolean; skipTrademark: boolean }) => {
      const result = await runDoctor(deps.config, deps.db, {
        skipTrademark: options.skipTrademark,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(result.ok ? 0 : 1);
      }

      process.stdout.write(formatDoctorReport(result));
      process.exit(result.ok ? 0 : 1);
    });
}

export interface DoctorOptions {
  /** Skip the live trademark-gate canary (smoke tests, offline installs). */
  skipTrademark?: boolean;
  /**
   * The free bytes of the filesystem, injected by the caller.
   *
   * The probe is a function of the machine, and the machine is not the same
   * in every environment: a CI container can have less than a gigabyte free
   * on its root filesystem, and a Windows host reports the volume differently
   * than a Linux container. The check therefore reports what it finds, and the
   * TEST decides what it asserts (the disk probe is injectable) instead of the
   * machine deciding whether the suite is green.
   */
  freeDiskBytes?: () => number;
}

export async function runDoctor(
  config: Config,
  db: Database.Database | null,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const skipTrademark = options.skipTrademark === true;
  const diskProbe = options.freeDiskBytes ?? freeDiskBytes;
  const checks: DoctorCheck[] = [];

  // ── 1: version ──────────────────────────────────────────────────────
  const version = readCliVersion();

  // ── 2: configuration ────────────────────────────────────────────────
  const cloudMode = !!config.DATABASE_URL;
  checks.push({
    name: 'mode',
    status: 'ok',
    detail: cloudMode ? 'cloud (PostgreSQL)' : 'community (SQLite)',
  });

  if (!cloudMode) {
    if (!config.API_KEYS) {
      checks.push({
        name: 'auth',
        status: 'warn',
        detail: 'API_KEYS is unset — the API will refuse to start on a public interface',
      });
    } else {
      checks.push({
        name: 'auth',
        status: 'ok',
        detail: 'API_KEYS is set',
      });
    }
    checks.push({
      name: 'database path',
      status: 'ok',
      detail: config.DATABASE_PATH,
    });
  } else {
    checks.push({
      name: 'database',
      status: 'ok',
      detail: 'PostgreSQL via DATABASE_URL',
    });
  }

  // ── 3: database integrity ───────────────────────────────────────────
  if (db) {
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      checks.push({
        name: 'database integrity',
        status: integrity.integrity_check === 'ok' ? 'ok' : 'fail',
        detail: integrity.integrity_check,
      });
    } catch (err) {
      checks.push({
        name: 'database integrity',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (cloudMode) {
    checks.push({
      name: 'database integrity',
      status: 'ok',
      detail: 'not a SQLite connection (cloud mode)',
    });
  } else {
    checks.push({
      name: 'database integrity',
      status: 'fail',
      detail: `database not initialized at ${config.DATABASE_PATH} — run \`dominus run\` once to create it`,
    });
  }

  // ── 4: schema vs manifest ───────────────────────────────────────────
  try {
    const provider = createSqliteProvider(config);
    const applied = await readAppliedMigrations(provider);
    const manifest = getMigrationManifest();
    const isPrefix =
      applied.length <= manifest.length && applied.every((name, i) => manifest[i] === name);
    checks.push({
      name: 'schema vs manifest',
      status: isPrefix ? 'ok' : 'fail',
      detail: `${applied.length} applied / ${manifest.length} in manifest`,
    });
    await provider.close().catch(() => {});
  } catch (err) {
    checks.push({
      name: 'schema vs manifest',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 5: DNS mode ─────────────────────────────────────────────────────
  checks.push({
    name: 'dns mode',
    status: 'ok',
    detail: config.DNS_UNBOUND_ENABLED
      ? 'Unbound (DNSSEC-validated)'
      : 'Node.js fallback (non-Available only)',
  });

  // ── 6: trademark gate canary ────────────────────────────────────────
  if (skipTrademark) {
    checks.push({
      name: 'trademark canary',
      status: 'ok',
      detail: 'skipped (--skip-trademark)',
    });
  } else {
    try {
      // Resolve the CLI entry point relative to this module, so the check
      // works whether dominus is run from source or from an installed prefix.
      const cliPath = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'dist',
        'cli.js',
      );
      const canRun = existsSync(cliPath);
      if (!canRun) {
        checks.push({
          name: 'trademark canary',
          status: 'warn',
          detail: 'dist/cli.js not built — run `npm run build` first',
        });
      } else {
        const nike = execFileSync(process.execPath, [cliPath, 'score', 'nike.com'], {
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, NODE_ENV: 'test' },
        });
        const vintage = execFileSync(process.execPath, [cliPath, 'score', 'vintagecoffee.com'], {
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, NODE_ENV: 'test' },
        });
        const nikeBlocked = /blocked/i.test(nike);
        const vintageClear = /clear/i.test(vintage);
        checks.push({
          name: 'trademark canary',
          status: nikeBlocked && vintageClear ? 'ok' : 'fail',
          detail: `nike=${nikeBlocked ? 'blocked' : 'not blocked'}, vintagecoffee=${vintageClear ? 'clear' : 'not clear'}`,
        });
      }
    } catch (err) {
      checks.push({
        name: 'trademark canary',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 7: backup age ───────────────────────────────────────────────────
  if (config.BACKUP_DIR) {
    const backupDir = join(config.BACKUP_DIR, 'migrations');
    if (existsSync(backupDir)) {
      let newest: Date | null = null;
      try {
        for (const name of readdirSync(backupDir)) {
          const full = join(backupDir, name);
          try {
            const st = statSync(full);
            if (st.isFile() && (!newest || st.mtime > newest)) newest = st.mtime;
          } catch {
            // A file that cannot be stat'ed is skipped, not fatal.
          }
        }
      } catch {
        // Directory listing failure is not fatal: the fresh backup is safe.
      }
      if (newest) {
        const ageHours = (Date.now() - newest.getTime()) / 3_600_000;
        checks.push({
          name: 'backup age',
          status: ageHours < 48 ? 'ok' : 'warn',
          detail: `newest pre-migration backup ${ageHours.toFixed(1)}h old`,
        });
      } else {
        checks.push({
          name: 'backup age',
          status: 'warn',
          detail: 'no pre-migration backups yet',
        });
      }
    } else {
      checks.push({
        name: 'backup age',
        status: 'warn',
        detail: 'backup directory does not exist yet (created on first migration)',
      });
    }
  } else {
    checks.push({
      name: 'backup age',
      status: 'ok',
      detail: 'BACKUP_DIR not configured',
    });
  }

  // ── 8: disk space ───────────────────────────────────────────────────
  try {
    const free = diskProbe();
    const freeGb = (free / 1_073_741_824).toFixed(1);
    checks.push({
      name: 'disk space',
      status: free > 1_073_741_824 ? 'ok' : 'warn',
      detail: `${freeGb} GB free`,
    });
  } catch {
    checks.push({
      name: 'disk space',
      status: 'warn',
      detail: 'could not determine free space',
    });
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { version, checks, ok };
}

/**
 * The free bytes of the filesystem the installation lives on.
 *
 * The probe is a function of the machine, and the machine is not the same
 * in every environment: a CI container can have less than a gigabyte free
 * on its root filesystem. The check therefore reports what it finds, and
 * the TEST decides what it asserts (the disk probe is injectable), instead
 * of the test depending on the free space of whoever runs it.
 */
export function freeDiskBytes(): number {
  if (process.platform === 'win32') {
    try {
      const out = execSync('fsutil volume diskfree C:', { encoding: 'utf8' });
      const m = /Free bytes\s*:\s*(\d+)/.exec(out);
      if (m) return Number(m[1]);
    } catch {
      // The probe could not run: zero free bytes, and the check warns.
    }
    return 0;
  }
  try {
    const out = execSync('df -P / | tail -1', { encoding: 'utf8' });
    const parts = out.trim().split(/\s+/);
    // `df -P` prints: filesystem blocks used available capacity mountpoint.
    // The fourth column is the available blocks (1 KB units). A short or
    // unexpected line must never produce NaN: NaN fails every comparison,
    // and the check would report a status nobody can explain.
    const available = Number(parts[3]);
    if (!Number.isFinite(available)) return 0;
    return available * 1024;
  } catch {
    return 0;
  }
}

function formatDoctorReport(result: DoctorResult): string {
  const lines: string[] = [];
  const width = Math.max(14, ...result.checks.map((c) => c.name.length));
  const statusIcon = { ok: '✓', warn: '⚠', fail: '✗' };

  lines.push(`DOMINUS doctor — v${result.version}`);
  lines.push(`Overall: ${result.ok ? 'healthy' : 'issues found'}`);
  lines.push('');

  for (const c of result.checks) {
    lines.push(`  ${statusIcon[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  }

  lines.push('');
  if (result.ok) {
    lines.push('All checks passed. The installation is healthy.');
  } else {
    lines.push('Some checks failed. Review the details above before operating.');
  }
  return lines.join('\n') + '\n';
}

function readCliVersion(): string {
  try {
    // Resolve the package.json from this module's location, not from the
    // caller's working directory: the installed CLI must report its own
    // version regardless of where the user runs it from.
    const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    const raw = readFileSync(here, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
