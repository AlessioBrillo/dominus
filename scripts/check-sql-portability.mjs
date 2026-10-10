#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Fails when SQLite-only SQL creeps back into code that also runs on PostgreSQL.
// Escape hatch for a deliberate SQLite-only line: put `sql-portability: sqlite-only`
// on that line or the one above it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = [
  'src/db/repositories',
  'src/services',
  'src/jobs',
  'src/api',
  'src/portfolio',
  'src/analytics',
  'src/listing',
  'src/watchlist',
  'src/scheduler',
  'src/app',
  'src/candidates',
  'src/pipeline',
];

const BANNED = [
  [
    /\bdatetime\s*\(/i,
    'datetime(): use CURRENT_TIMESTAMP or a JS cutoff (src/db/sql-timestamp.ts)',
  ],
  [/\bstrftime\s*\(/i, 'strftime(): compute the value in JS'],
  [/\bjulianday\s*\(/i, 'julianday(): compute the value in JS'],
  [
    /\bINSERT\s+OR\s+(REPLACE|IGNORE)\b/i,
    'INSERT OR REPLACE/IGNORE: use ON CONFLICT ... DO UPDATE/NOTHING',
  ],
  [/\bIFNULL\s*\(/i, 'IFNULL(): use COALESCE()'],
  [/\bGROUP_CONCAT\s*\(/i, 'GROUP_CONCAT(): not portable'],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'migrations') continue;
      yield* walk(p);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) {
      yield p;
    }
  }
}

const problems = [];
for (const root of ROOTS) {
  let files;
  try {
    files = [...walk(root)];
  } catch {
    continue;
  }
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (line.includes('sql-portability: sqlite-only')) return;
      if ((lines[i - 1] ?? '').includes('sql-portability: sqlite-only')) return;
      for (const [re, why] of BANNED) {
        if (re.test(line)) problems.push(`${relative('.', file)}:${i + 1}  ${why}\n    ${trimmed}`);
      }
    });
  }
}

if (problems.length > 0) {
  console.error(`SQL portability check failed (${problems.length}):\n`);
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('SQL portability check passed.');
