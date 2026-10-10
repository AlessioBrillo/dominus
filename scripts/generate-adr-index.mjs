#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Rebuilds the ADR index table in docs/adr/README.md from the ADR files, so the
// index can never disagree with an ADR's own title, date or status (it had
// drifted: missing rows, wrong statuses, a malformed row).
//
//   node scripts/generate-adr-index.mjs          rewrite the table
//   node scripts/generate-adr-index.mjs --check  exit 1 if it is out of date
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';

const DIR = 'docs/adr';
const README = join(DIR, 'README.md');
const TABLE_END = '## Conventions';

function field(src, name) {
  const row = new RegExp(`\\|\\s*\\*\\*${name}\\*\\*\\s*\\|\\s*([^|]*?)\\s*\\|`, 'i').exec(src);
  if (row) return row[1];
  // `**Status**: Accepted` / `status: accepted` layouts (older ADRs).
  const fm = new RegExp(`^(?:\\*\\*)?${name}(?:\\*\\*)?:\\s*(.+)$`, 'im').exec(src);
  return fm ? fm[1].trim() : '';
}

const stripLinks = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const rows = readdirSync(DIR)
  .filter((f) => /^\d{4}-.+\.md$/.test(f))
  .sort()
  .map((file) => {
    const src = readFileSync(join(DIR, file), 'utf8');
    const num = file.slice(0, 4);
    const title = /^#\s*ADR-\d{4}:\s*(.+)$/m.exec(src)?.[1]?.trim() ?? file;
    const date = field(src, 'Date').replace(/\s.*$/, '');
    const status = cap(stripLinks(field(src, 'Status')));
    // Escape backslashes first, otherwise a title ending in "\" would swallow the cell pipe.
    const cell = title.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    return `| [${num}](${file}) | ${cell} | ${date} | ${status} |`;
  });

const table = ['| ADR | Title | Date | Status |', '| --- | --- | --- | --- |', ...rows].join('\n');

const current = readFileSync(README, 'utf8').replace(/\r\n/g, '\n');
const start = current.indexOf('| ADR ');
const end = current.indexOf(TABLE_END);
if (start < 0 || end < 0) {
  console.error('generate-adr-index: table markers not found');
  process.exit(2);
}

const draft = `${current.slice(0, start)}${table}\n\n${current.slice(end)}`;
const config = (await prettier.resolveConfig(README)) ?? {};
const next = await prettier.format(draft, { ...config, parser: 'markdown' });

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('docs/adr/README.md index is out of date. Run: npm run adr:index');
    process.exit(1);
  }
  console.log('ADR index is up to date.');
} else {
  writeFileSync(README, next);
  console.log(`ADR index regenerated (${rows.length} ADRs).`);
}
