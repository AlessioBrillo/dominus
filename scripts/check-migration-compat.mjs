#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Static schema migration gate (see docs/releases/migration-policy.md).
//
// DOMINUS deploys are rollback-safe only while migrations are additive:
// the release gate refuses to ship any migration whose DDL is destructive
// on the database. Because the auto-rollback boots the previous image
// against the post-release schema, dropping/renaming/rewriting columns or
// deleting rows would break the previous code (or lose data) the moment a
// release is rolled back.
//
// Destructive patterns (any occurrence in a migration file FAILS the gate
// unless paired with a fixup):
//   - DROP TABLE <name>            — allowed ONLY when the same migration
//                                    also issues CREATE TABLE <name> (the
//                                    idempotent recreate pattern).
//   - ALTER TABLE ... DROP COLUMN  — always destructive.
//   - ALTER TABLE ... RENAME TO    — always destructive.
//   - ALTER TABLE ... RENAME COLUMN — always destructive.
//   - ALTER COLUMN ... SET NOT NULL — always destructive.
//   - DELETE FROM                  — always destructive (data loss).
//
// Exemptions:
//   - A migration file containing `backwardCompatible: true` on its
//     exported object documents an explicit, reviewed override.
//   - ALLOWLIST_HISTORICAL: migrations that predate this policy. They
//     already shipped; blocking them now would block nothing and re-listing
//     their exact DDL here documents what must not be repeated.
//
// Usage:
//   node scripts/check-migration-compat.mjs              (scan src/db/migrations)
//   node scripts/check-migration-compat.mjs [paths...]   (scan given dirs/files)
//   node scripts/check-migration-compat.mjs --test       (fixture suite)
//   exit 0 = green, exit 1 = red (destructive DDL or failing fixture)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', 'src', 'db', 'migrations');
const FIXTURE_DIR = join(HERE, '__fixtures__', 'migration-compat');

// Historical migrations that predate the additive-first policy (v1.1.0).
// Each entry documents what was done and why it must not be repeated.
const ALLOWLIST_HISTORICAL = [
  {
    prefix: '0011_rename_weights_snapshot',
    reason: 'RENAME COLUMN weights_snapshot -> signal_scores (pre-gate era)',
  },
  {
    prefix: '0015_fix_scoring_runs_trademark_constraints',
    reason: 'table rebuild via DROP + RENAME TO (pre-gate era)',
  },
  {
    prefix: '0029_add_tenant_id',
    reason: 'DROP COLUMN tenant_id — removed early multi-tenant experiment (pre-gate era)',
  },
  {
    prefix: '0036_add_pipeline_lock_worker_id',
    reason: 'table rebuild via DROP + RENAME TO (pre-gate era)',
  },
  {
    prefix: '0042_add_job_heartbeat',
    reason: 'DROP COLUMN locked_by/heartbeat_at (pre-gate era)',
  },
  {
    prefix: '0049_add_team_plan',
    reason: 'DELETE FROM plan_limits WHERE plan=\'team\' (pre-gate era)',
  },
];

// --- analysis ------------------------------------------------------------

/** Strip // and /* *​/ comments while keeping string contents intact. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inString = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1] ?? '';
    if (inString !== null) {
      out += c;
      if (c === '\\') {
        out += n;
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === '`' || c === '"' || c === "'") inString = c;
    out += c;
    i += 1;
  }
  return out;
}

/** Collapse whitespace and uppercase for pattern matching. */
function normalize(sql) {
  return sql.replace(/\s+/g, ' ').toUpperCase();
}

const NAME_RE = /(?:[\w."`[\]]+\.)?([A-Z_][A-Z0-9_]*)/i;

function tableName(pattern, sql) {
  // Accepts `CREATE TABLE x`, `CREATE TABLE IF EXISTS x` and the common
  // idempotent `CREATE TABLE IF NOT EXISTS x` / `DROP TABLE IF EXISTS x`.
  const re = new RegExp(
    `${pattern}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(?:[\\w."\`\\[\\]]+\\.)?([A-Z_][A-Z0-9_]*)`,
    'gi',
  );
  return [...sql.matchAll(re)].map((m) => m[1].toLowerCase());
}

/**
 * Static analysis of one migration file. Returns an array of human-readable
 * findings; empty array = migration is compatible with the release gate.
 */
export function scanMigrationContent(content, file) {
  const stripped = stripComments(content);
  const sql = normalize(stripped);
  const findings = [];

  if (/backwardCompatible\s*:\s*true/.test(content)) return findings;

  // DROP TABLE: destructive unless the same migration recreates the table
  // (the idempotent recreate pattern used by several historical fixes).
  const dropped = tableName('DROP\\s+TABLE', sql, 'drop');
  const created = new Set(tableName('CREATE\\s+TABLE', sql, 'create'));
  for (const table of dropped) {
    if (!created.has(table)) {
      findings.push(`${file}: DROP TABLE ${table} without a matching CREATE TABLE in the same migration`);
    }
  }

  // ALTER TABLE ... DROP COLUMN
  if (/ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN/i.test(sql)) {
    findings.push(`${file}: ALTER TABLE ... DROP COLUMN — destructive on rollback`);
  }

  // ALTER TABLE ... RENAME TO
  if (/ALTER\s+TABLE\s+\S+\s+RENAME\s+TO\s+\S+/i.test(sql)) {
    findings.push(`${file}: ALTER TABLE ... RENAME TO — destructive on rollback`);
  }

  // RENAME COLUMN
  if (/RENAME\s+COLUMN/i.test(sql)) {
    findings.push(`${file}: RENAME COLUMN — destructive on rollback`);
  }

  // SET NOT NULL
  if (/SET\s+NOT\s+NULL/i.test(sql)) {
    findings.push(`${file}: ALTER COLUMN ... SET NOT NULL — destructive on rollback`);
  }

  // DELETE FROM
  if (/DELETE\s+FROM\s+\S+/i.test(sql)) {
    findings.push(`${file}: DELETE FROM — irreversible data deletion`);
  }

  return findings;
}

function isAllowlisted(file) {
  const base = file.split(/[\\/]/).at(-1) ?? '';
  return ALLOWLIST_HISTORICAL.some((entry) => base.startsWith(entry.prefix));
}

function scanFile(file) {
  const content = readFileSync(file, 'utf8');
  const findings = scanMigrationContent(content, file);
  if (isAllowlisted(file)) return [];
  return findings;
}

function collectFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

export function runGuard(roots) {
  const findings = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      findings.push(`${root}: path not found`);
      continue;
    }
    const files = statSync(root).isDirectory() ? collectFiles(root) : [root];
    for (const file of files) findings.push(...scanFile(file));
  }
  return findings;
}

// --- fixture suite --------------------------------------------------------

function runTests() {
  const failures = [];
  let cases = 0;

  const goodDir = join(FIXTURE_DIR, 'good');
  const badDir = join(FIXTURE_DIR, 'bad');
  if (!existsSync(goodDir) || !existsSync(badDir)) {
    console.error(`check-migration-compat --test: fixtures missing in ${FIXTURE_DIR}`);
    process.exit(1);
  }

  for (const file of collectFiles(goodDir)) {
    cases += 1;
    const content = readFileSync(file, 'utf8');
    const findings = scanMigrationContent(content, file);
    if (findings.length > 0) {
      failures.push(`${file}: expected GREEN, got ${findings.join('; ')}`);
    }
  }

  for (const file of collectFiles(badDir)) {
    cases += 1;
    const content = readFileSync(file, 'utf8');
    const findings = scanMigrationContent(content, file);
    if (findings.length === 0) {
      failures.push(`${file}: expected RED (destructive DDL), got GREEN`);
    }
  }

  // The real repository must be green thanks to the historical allowlist.
  cases += 1;
  const repoFindings = runGuard([DEFAULT_ROOT]);
  if (repoFindings.length > 0) {
    failures.push(`src/db/migrations: expected GREEN, got:\n  ${repoFindings.join('\n  ')}`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-migration-compat --test: ${failures.length}/${cases} case(s) failed`);
    process.exit(1);
  }
  console.error(`check-migration-compat --test: all ${cases} case(s) passed`);
}

// --- CLI ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--test')) {
    runTests();
    return;
  }
  const roots = args.length > 0 ? args : [DEFAULT_ROOT];
  const findings = runGuard(roots);
  if (findings.length > 0) {
    console.error(`check-migration-compat: FAIL — ${findings.length} destructive migration finding(s)`);
    for (const f of findings) console.error(`  - ${f}`);
    console.error(
      '  Fix: make the migration additive (add a column, never drop/rename), or — with explicit review — ' +
        'mark the exported object backwardCompatible: true.',
    );
    process.exit(1);
  }
  console.error('check-migration-compat: OK — all migrations are additive (release-gate safe)');
}

main();
