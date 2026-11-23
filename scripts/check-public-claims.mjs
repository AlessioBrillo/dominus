#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public-claims guardrail.
 *
 * `check-legal-placeholders` watches the legal surface for unfinished text.
 * This check watches the rest of the public surface for claims the product
 * cannot back: legal conclusions dressed up as features, certifications that
 * were never granted, prices and limits that belong to a different edition,
 * and outcomes the heuristic engine does not guarantee.
 *
 * The rules are deliberately mechanical. A claim that is wrong in a README,
 * a landing page or a server-rendered view is indistinguishable from a correct
 * one by reading alone, so it is checked on every change instead. The check
 * is a static guardrail: it carries no dependency, starts no service and
 * reads only the files below. Its own pattern strings are never scanned, so
 * it cannot trip over its own detector.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const README = 'README.md';
const INDEX_HTML = 'frontend/index.html';
const LANDING_PAGE = 'frontend/src/pages/LandingPage.tsx';
const BILLING_PAGE = 'frontend/src/pages/BillingPage.tsx';
const FOR_SALE_PAGE = 'src/api/views/for-sale-page.ts';
const DOMAIN_PAGE = 'src/api/views/domain-page.ts';
const SCORE_PAGE = 'src/api/views/score-page.ts';
const COMPARE_PAGE = 'src/api/views/compare-page.ts';
const LEGAL_CONTENT = 'src/services/legal-content.ts';
const LEGAL_SURFACE = 'docs/legal/legal-surface.md';
const LAUNCH_READINESS = 'docs/releases/cloud-launch-readiness.md';

/** Every file whose words a reader can take as a statement about the product. */
const FILES = [
  README,
  INDEX_HTML,
  LANDING_PAGE,
  BILLING_PAGE,
  FOR_SALE_PAGE,
  DOMAIN_PAGE,
  SCORE_PAGE,
  COMPARE_PAGE,
  LEGAL_CONTENT,
  LEGAL_SURFACE,
  LAUNCH_READINESS,
];

/** Documentation files are the only place the withdrawal-waiver rule applies. */
const DOCS = [LEGAL_SURFACE, LAUNCH_READINESS];

const EDITION_LIMIT_MESSAGE =
  'self-hosted Community edition has no such limit; those are Cloud Free-tier limits';

/**
 * Forbidden claims. `files` narrows a pattern to a subset of FILES; without
 * it the pattern applies to every public file.
 */
const FORBIDDEN_PATTERNS = [
  {
    pattern: /trademark clearance/i,
    message: 'trademark clearance is a legal conclusion; the product performs a screening',
  },
  {
    pattern: /GDPR compliant/i,
    message: 'do not claim GDPR compliance as a certification',
  },
  {
    pattern: /free forever/i,
    message: "do not promise 'free forever'; say 'free software, no paid tier required'",
  },
  {
    pattern: /guaranteed (?:value|sale|return)/i,
    message: 'do not guarantee valuation outcomes',
  },
  {
    pattern: /50 candidates scored per month/i,
    files: [LANDING_PAGE],
    message: EDITION_LIMIT_MESSAGE,
  },
  {
    pattern: /25 domains tracked/i,
    files: [LANDING_PAGE],
    message: EDITION_LIMIT_MESSAGE,
  },
  {
    pattern: /art\. 59\(1\)\(o\) consent/i,
    files: DOCS,
    message: 'the operator does not rely on the art. 59(1)(o) withdrawal waiver',
  },
  {
    pattern: /\[●\]/,
    files: [LEGAL_CONTENT],
    message: 'unfilled DPA clause in published legal text',
  },
];

const failures = [];
const sources = new Map();

for (const relPath of FILES) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    failures.push(`missing file: ${relPath}`);
    sources.set(relPath, '');
    continue;
  }
  sources.set(relPath, readFileSync(abs, 'utf-8'));
}

for (const { pattern, files, message } of FORBIDDEN_PATTERNS) {
  for (const relPath of files ?? FILES) {
    const source = sources.get(relPath);
    if (source === undefined) continue;
    const match = pattern.exec(source);
    if (!match) continue;
    const line = source.slice(0, match.index).split('\n').length;
    failures.push(
      `${relPath}:${line} ${message} (found "${match[0]}")`,
    );
  }
}

if (failures.length > 0) {
  console.error(`check-public-claims: FAILED (${failures.length} problem(s))`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nA public claim is a promise to a reader. If the product does not do it, ' +
      'fix the claim - not this check.',
  );
  process.exit(1);
}

console.log(
  `check-public-claims: OK - ${FORBIDDEN_PATTERNS.length} forbidden patterns checked in ${FILES.length} files`,
);
