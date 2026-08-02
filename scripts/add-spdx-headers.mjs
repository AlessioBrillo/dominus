// One-time pass: prepend an SPDX license header to every source file.
// Run: node scripts/add-spdx-headers.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const HEADER = '// SPDX-License-Identifier: AGPL-3.0-only\n';
const roots = ['src', 'frontend/src'];
const exts = new Set(['.ts', '.tsx', '.mts', '.cts']);
const skipDirs = new Set(['node_modules', 'dist', 'coverage', '__snapshots__']);

let added = 0;
let skipped = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (skipDirs.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (exts.has(extname(entry))) {
      const content = readFileSync(full, 'utf8');
      if (content.startsWith(HEADER) || content.startsWith('/* SPDX-License-Identifier')) {
        skipped++;
        continue;
      }
      const shebang = content.startsWith('#!') ? content.slice(0, content.indexOf('\n') + 1) : '';
      const rest = shebang ? content.slice(shebang.length) : content;
      writeFileSync(full, shebang + HEADER + rest);
      added++;
    }
  }
}

for (const root of roots) walk(root);
console.log(`SPDX headers added: ${added}, already present: ${skipped}`);
