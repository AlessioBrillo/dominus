#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Regenerates the "Runtime dependencies (backend)" table of
// THIRD-PARTY-NOTICES.md from package.json and the installed packages, so the
// list cannot drift from what actually ships (it had lost undici, and gained
// packages nobody added by hand).
//
//   node scripts/generate-notices.mjs          rewrite the file
//   node scripts/generate-notices.mjs --check  exit 1 if it is out of date
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'THIRD-PARTY-NOTICES.md';
const START = '## Runtime dependencies (backend)';
const END = '## Runtime dependencies (frontend)';

// Context a license column cannot carry.
const NOTES = {
  pg: 'Optional: PostgreSQL driver',
  nodemailer: 'Loaded only when SMTP_URL is set (team invitations, email alerts)',
  sharp:
    'Optional: image processing. **Bundles libvips (LGPL-3.0-or-later) as a native binary.** The LGPL component is dynamically linked and may be replaced by rebuilding sharp; full license text: https://www.gnu.org/licenses/lgpl-3.0.html',
};

function licenseOf(name) {
  const pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8'));
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object') {
    return Array.isArray(l) ? l.map((x) => x.type ?? x).join(' OR ') : (l.type ?? 'UNKNOWN');
  }
  return 'UNKNOWN';
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const names = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
].sort((a, b) => a.localeCompare(b));

const rows = names.map((n) => `| ${n} | ${licenseOf(n)} | ${NOTES[n] ?? ''} |`);
const table = ['| Package | License | Note |', '|---------|---------|------|', ...rows].join('\n');

const current = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const a = current.indexOf(START);
const b = current.indexOf(END);
if (a < 0 || b < 0) {
  console.error(`generate-notices: markers not found in ${FILE}`);
  process.exit(2);
}
const next = `${current.slice(0, a)}${START}\n\n${table}\n\n${current.slice(b)}`;

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error(`${FILE} is out of date. Run: npm run notices`);
    process.exit(1);
  }
  console.log(`${FILE} is up to date.`);
} else {
  writeFileSync(FILE, next);
  console.log(`${FILE} updated (${names.length} runtime dependencies).`);
}
