#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Documentation drift gate.
 *
 * The launch audit found the docs describing an architecture that no
 * longer exists: route/handler/command counts that drifted by a third,
 * provider class names that were never real, Kubernetes as a deployment
 * target two releases after it was removed, and the 2-of-3 DNS consensus
 * topology that ADR-0072/0075 superseded. Every one of those was
 * accurate when written and rotted silently afterwards — nothing in CI
 * compared the documents against the code.
 *
 * This script closes that class of defect. Each check derives its truth
 * from the source tree, so adding a route module updates the check instead
 * of breaking it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const failures = [];
let checksRun = 0;

function fail(message) {
  failures.push(message);
}

/* ------------------------------------------------------------------ *
 * Source-tree facts
 * ------------------------------------------------------------------ */
function listFiles(dir, { exclude = [], suffix = '.ts' } = {}) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith(suffix) && !exclude.includes(f))
    .filter((f) => statSync(join(abs, f)).isFile());
}

/** Every markdown file that is part of the published documentation set. */
function docsFiles() {
  const out = [join(root, 'README.md')];
  const docs = join(root, 'docs');
  if (!existsSync(docs)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(docs);
  return out;
}

const DOC_FILES = docsFiles();

function readDoc(absPath) {
  return readFileSync(absPath, 'utf-8');
}

function rel(absPath) {
  return relative(root, absPath).split('\\').join('/');
}

/* ------------------------------------------------------------------ *
 * Check 1 — module counts quoted in docs must match the source tree
 * ------------------------------------------------------------------ */
const COUNTED_ENTITIES = [
  {
    entity: 'route modules',
    sourceDir: 'src/api/routes',
    // e.g. "29 route modules"
    pattern: /(\d+)\s+route modules/g,
  },
  {
    entity: 'repositories',
    sourceDir: 'src/db/repositories',
    pattern: /(\d+)\s+repositories/g,
  },
  {
    entity: 'job handlers',
    sourceDir: 'src/jobs/handlers',
    exclude: ['index.ts'],
    pattern: /(\d+)\s+handlers/g,
  },
  {
    entity: 'CLI commands',
    sourceDir: 'src/cli/commands',
    pattern: /(\d+)\s+commands/g,
  },
];

for (const { entity, sourceDir, exclude = [], pattern } of COUNTED_ENTITIES) {
  const actual = listFiles(sourceDir, { exclude }).length;
  if (actual === 0) {
    fail(`check-doc-drift: ${sourceDir} produced a count of 0 — path or filter is wrong`);
    continue;
  }
  checksRun += 1;
for (const doc of DOC_FILES) {
  // ADRs are immutable point-in-time records (see docs/adr/README.md): a
  // count quoted in ADR-0027 was true when it was written, so it is not
  // drift. Everything else is maintained documentation.
  if (rel(doc).startsWith('docs/adr/')) continue;
  const text = readDoc(doc);
  let match;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    const claimed = Number(match[1]);
    if (claimed !== actual) {
      const line = text.slice(0, match.index).split('\n').length;
      fail(`${rel(doc)}:${line} claims ${claimed} ${entity} but ${sourceDir} has ${actual}`);
    }
  }
}
}

/* ------------------------------------------------------------------ *
 * Check 2 — symbols that no longer exist must not be presented as real
 * ------------------------------------------------------------------ */
/**
 * Every entry below is a symbol the audit found documented as live code
 * when no such module exists. Removing them is not a judgement call: a
 * reader who follows a customization guide and writes
 * `new NodeDnsProvider()` gets a compile error.
 */
const RETIRED_SYMBOLS = [
  {
    symbol: 'NodeDnsProvider',
    why: 'removed with the Unbound migration; the real classes are UnboundResolver / NodeDnsFallback',
  },
  {
    symbol: 'GoogleDnsProvider',
    why: 'never existed',
  },
  {
    symbol: 'ARdapProvider',
    why: 'never existed',
  },
  {
    symbol: 'WhoisXmlProvider',
    why: 'never existed',
  },
  {
    symbol: 'GoogleAdsKeywordProvider',
    why: 'the real class is GoogleAdsProvider',
  },
  {
    symbol: 'NameBioCompsProvider',
    why: 'the real class is NameBioProvider',
  },
  {
    symbol: 'RetryableProvider',
    why: 'the real class is RetryingProvider',
  },
  {
    symbol: 'UsptoProvider',
    why: 'the real class is UsptoCasesProvider',
  },
  {
    symbol: 'NamecheapRegistrarProvider',
    why: 'removed in 1.1.0 (ADR-0082); only CloudflareRegistrarProvider and ManualRegistrarProvider ship',
  },
  {
    symbol: 'GoDaddyRegistrarProvider',
    why: 'removed in 1.1.0 (ADR-0082)',
  },
  {
    symbol: 'PorkbunRegistrarProvider',
    why: 'removed in 1.1.0 (ADR-0082)',
  },
  {
    symbol: 'NameSiloRegistrarProvider',
    why: 'removed in 1.1.0 (ADR-0082)',
  },
  {
    symbol: 'DynadotRegistrarProvider',
    why: 'removed in 1.1.0 (ADR-0082)',
  },
];

checksRun += 1;
for (const { symbol, why } of RETIRED_SYMBOLS) {
  for (const doc of DOC_FILES) {
    const text = readDoc(doc);
    if (!text.includes(symbol)) continue;
    // ADR documents legitimately record what was removed and why.
    if (rel(doc).includes('docs/adr/')) continue;
    const line = text.slice(0, text.indexOf(symbol)).split('\n').length;
    fail(`${rel(doc)}:${line} references retired symbol \`${symbol}\` (${why})`);
  }
}

/* ------------------------------------------------------------------ *
 * Check 3 — removed deployment targets and superseded topologies
 * ------------------------------------------------------------------ */
const RETIRED_CONCEPTS = [
  {
    concept: 'Kubernetes',
    // deploy/ no longer ships manifests (removed in 1.1.0, ADR-0082).
    // "not Kubernetes" is allowed; "K8s deployment" style claims are not.
    pattern: /k(?:8s|ubernetes)/gi,
    allowIn: (p) => p.includes('docs/adr/') || p.includes('docs/releases/'),
  },
  {
    concept: '2-of-3 DNS resolver consensus',
    // Superseded by ADR-0072/0075: Unbound is the single source of truth.
    pattern: /2-of-3/g,
    allowIn: (p) => p.includes('docs/adr/') || p.includes('docs/releases/'),
  },
  {
    concept: 'DNS_CONSENSUS_ / DNS_TERTIARY_ configuration',
    // Removed env vars in 1.1.0; docs listing them are stale.
    pattern: /DNS_(CONSENSUS|TERTIARY)_[A-Z_]+/g,
    allowIn: (p) => p.includes('docs/adr/') || p.includes('docs/releases/'),
  },
];

checksRun += 1;
for (const { concept, pattern, allowIn } of RETIRED_CONCEPTS) {
  for (const doc of DOC_FILES) {
    const p = rel(doc);
    if (allowIn(p)) continue;
    const text = readDoc(doc);
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      // "Kubernetes" inside an explicit removal note is fine.
      const lineText = text.split('\n')[line - 1] ?? '';
      if (/removed|no longer|dropped|retired|not provided|not shipped|unsupported/i.test(lineText)) {
        continue;
      }
      fail(`${p}:${line} mentions retired concept "${match[0]}" (${concept})`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Check 4 — mermaid diagrams must be syntactically balanced
 * ------------------------------------------------------------------ */
/**
 * Checks bracket balance per line inside mermaid fences. `[`/`]` and
 * `{`/`}` are checked; parentheses are skipped because node labels
 * routinely contain prose parentheses, which makes them unreliable.
 * The defect this catches: `REDIS[("Redis<br/>(optional cache)"` opens a
 * square bracket that is never closed, so GitHub renders the whole
 * diagram as a code block instead.
 */
const MERMAID_FENCE = /^```mermaid\s*$/;

checksRun += 1;
for (const doc of DOC_FILES) {
  const lines = readDoc(doc).split('\n');
  let inMermaid = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Any fence closes a mermaid block. Without this, a ```ts sample that
    // follows a ```mermaid block is scanned as diagram syntax.
    if (/^```/.test(line)) {
      inMermaid = MERMAID_FENCE.test(line);
      continue;
    }
    if (!inMermaid) continue;
    // Strip prose inside quotes so a "(" in a label cannot fake balance.
    const stripped = line.replace(/"[^"]*"/g, '""');
    for (const [open, close] of [
      ['[', ']'],
      ['{', '}'],
    ]) {
      const opens = stripped.split(open).length - 1;
      const closes = stripped.split(close).length - 1;
      if (opens !== closes) {
        fail(
          `${rel(doc)}:${i + 1} mermaid line has ${opens} "${open}" but ${closes} "${close}" — ` +
            'GitHub will render the diagram as a code block',
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Check 5 — relative markdown links must resolve to a real file
 * ------------------------------------------------------------------ */
/**
 * Matches markdown links whose target is a repository-relative path.
 * Accepts both `docs/x.md` and `./x.md` / `../x.md` forms: a link written
 * without `./` is still resolved from the containing file's directory, so
 * `docs/adr/x.md` inside `docs/deployment/README.md` is broken even though
 * it looks like a top-level path.
 */
const MD_LINK = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;

checksRun += 1;
for (const doc of DOC_FILES) {
  const text = readDoc(doc);
  let match;
  MD_LINK.lastIndex = 0;
  while ((match = MD_LINK.exec(text)) !== null) {
    const target = match[1].split('#')[0];
    if (target.length === 0) continue;
    const resolved = resolve(dirname(doc), target);
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split('\n').length;
      fail(`${rel(doc)}:${line} links to "${target}" which does not exist`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Check 6 — ADR index must cover every ADR file and vice versa
 * ------------------------------------------------------------------ */
const ADR_DIR = 'docs/adr';
const adrFiles = listFiles(ADR_DIR).filter((f) => /^\d{4}-/.test(f)).sort();
const indexPath = join(root, ADR_DIR, 'README.md');

if (!existsSync(indexPath)) {
  fail(`check-doc-drift: ${ADR_DIR}/README.md is missing — the ADR index is required`);
} else {
  checksRun += 1;
  const indexText = readDoc(indexPath);
  for (const adr of adrFiles) {
    if (!indexText.includes(adr)) {
      fail(`${ADR_DIR}/README.md does not list ${adr}`);
    }
  }
  // The reverse direction catches index rows pointing at deleted ADRs.
  const indexLinks = [...indexText.matchAll(/\]\((\.\/[^)\s]+)\)/g)].map((m) =>
    m[1].replace(/^\.\//, '').split('#')[0],
  );
  for (const linked of indexLinks) {
    if (linked.endsWith('/') || linked.length === 0) continue;
    if (!adrFiles.includes(linked)) {
      fail(`${ADR_DIR}/README.md links to ${linked}, which is not an ADR file in ${ADR_DIR}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.error(`check-doc-drift: FAILED (${failures.length} problem(s) across ${checksRun} checks)`);
  for (const f of failures.slice(0, 60)) console.error(`  - ${f}`);
  if (failures.length > 60) console.error(`  ... and ${failures.length - 60} more`);
  console.error(
    '\nCounts are derived from the source tree, so they cannot go stale on ' +
      'their own — update the document, not the check. Retired symbols and ' +
      'concepts are listed in scripts/check-doc-drift.mjs.',
  );
  process.exit(1);
}

console.log(
  `check-doc-drift: OK — ${checksRun} checks over ${DOC_FILES.length} documents ` +
    `(${COUNTED_ENTITIES.map((e) => `${e.entity}=${listFiles(e.sourceDir, { exclude: e.exclude }).length}`).join(', ')})`,
);
