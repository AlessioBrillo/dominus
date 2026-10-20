#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Legal surface guardrail.
 *
 * The legal surface is the part of the product where a silent regression is
 * indistinguishable from a correct state: a page that publishes
 * `privacy@dominus.example` looks exactly like a page that publishes the
 * real address, and a missing withdrawal clause looks exactly like a
 * document that simply does not mention withdrawal. Reviewers do not notice
 * either, and neither do tests.
 *
 * So the rules that matter are checked mechanically, in the repository, on
 * every change:
 *
 *   1. no placeholder ever reaches the published documents;
 *   2. the operator identity fields art. 7 D.Lgs. 70/2003 requires are
 *      rendered by the legal notice;
 *   3. the clauses the EU consumer and data protection law requires are
 *      present in the documents (withdrawal, reverse charge, sub-processors,
 *      supervisory authority);
 *   4. the legal documents are reachable from every public page: the
 *      server-rendered template carries the footer, and the SPA registers
 *      the three routes;
 *   5. the deployment surface is documented: the identity environment
 *      variables exist in the configuration and in .env.example.
 *
 * The runtime counterpart is `npm run launch:check`, which verifies the same
 * things against a running deployment, with the real configured values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function read(relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    failures.push(`missing file: ${relPath}`);
    return '';
  }
  return readFileSync(abs, 'utf-8');
}

/* ------------------------------------------------------------------ *
 * 1. No placeholder in the published documents
 * ------------------------------------------------------------------ */
const LEGAL_SOURCE = 'src/services/legal-content.ts';
const legalSource = read(LEGAL_SOURCE);

const PLACEHOLDERS = [
  { pattern: /\bTBD\b/, what: 'an unresolved "TBD"' },
  { pattern: /\bTODO\b/, what: 'an unresolved "TODO"' },
  { pattern: /CHANGE_ME/, what: 'a "CHANGE_ME" placeholder' },
  { pattern: /\.example\b/, what: 'a reserved ".example" domain' },
  { pattern: /privacy@dominus/, what: 'the placeholder privacy address' },
  { pattern: /lorem ipsum/i, what: 'lorem ipsum' },
];

for (const { pattern, what } of PLACEHOLDERS) {
  const match = legalSource.match(pattern);
  if (match) {
    const line = legalSource.slice(0, match.index).split('\n').length;
    failures.push(`${LEGAL_SOURCE}:${line} contains ${what} — it would be published as-is`);
  }
}

/* ------------------------------------------------------------------ *
 * 2. The identity fields the law requires are rendered
 * ------------------------------------------------------------------ */
const REQUIRED_IDENTITY_RENDERINGS = [
  { field: 'vatId', what: 'VAT identification number' },
  { field: 'reaNumber', what: 'business register number' },
  { field: 'pec', what: 'certified electronic address' },
  { field: 'contactEmail', what: 'contact address' },
  { field: 'privacyEmail', what: 'data protection contact' },
];

for (const { field, what } of REQUIRED_IDENTITY_RENDERINGS) {
  if (!legalSource.includes(`identity.${field}`)) {
    failures.push(`${LEGAL_SOURCE} does not render the ${what} (identity.${field})`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. The clauses the law requires are present
 * ------------------------------------------------------------------ */
const REQUIRED_CLAUSES = [
  { pattern: /right of withdrawal/i, what: 'the right of withdrawal' },
  { pattern: /reverse charge/i, what: 'the reverse charge mechanism' },
  { pattern: /sub-processor/i, what: 'the sub-processor list' },
  { pattern: /supervisory authority/i, what: 'the supervisory authority' },
  { pattern: /art\. 7/, what: 'the art. 7 D.Lgs. 70/2003 reference' },
  { pattern: /art\. 59/, what: 'the art. 59 Consumer Code reference' },
];

for (const { pattern, what } of REQUIRED_CLAUSES) {
  if (!pattern.test(legalSource)) {
    failures.push(`${LEGAL_SOURCE} does not mention ${what}`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. The documents are reachable from every public page
 * ------------------------------------------------------------------ */
const TEMPLATE = 'src/api/views/page-template.ts';
const template = read(TEMPLATE);
if (!template.includes('legalFooterHtml')) {
  failures.push(`${TEMPLATE} does not render the legal footer — the public pages would not identify the operator`);
}

const FOOTER = 'src/api/views/legal-footer.ts';
const footer = read(FOOTER);
for (const route of ['/terms', '/privacy', '/legal-notice']) {
  if (!footer.includes(`href="${route}"`)) {
    failures.push(`${FOOTER} does not link to ${route}`);
  }
}

const MAIN_TSX = 'frontend/src/main.tsx';
const mainTsx = read(MAIN_TSX);
for (const route of ['terms', 'privacy', 'legal-notice']) {
  if (!mainTsx.includes(`path="${route}"`)) {
    failures.push(`${MAIN_TSX} does not register the /${route} route`);
  }
}

const PUBLIC_ROUTER = 'src/api/public-router.ts';
const publicRouter = read(PUBLIC_ROUTER);
if (!publicRouter.includes("router.get('/legal'")) {
  failures.push(`${PUBLIC_ROUTER} does not serve /public/legal`);
}

/* ------------------------------------------------------------------ *
 * 5. The deployment surface is documented
 * ------------------------------------------------------------------ */
const CONFIG = 'src/config.ts';
const config = read(CONFIG);
const ENV_EXAMPLE = '.env.example';
const envExample = read(ENV_EXAMPLE);

const IDENTITY_VARS = [
  'LEGAL_ENTITY_NAME',
  'LEGAL_ENTITY_KIND',
  'LEGAL_REGISTERED_ADDRESS',
  'LEGAL_VAT_ID',
  'LEGAL_REA_NUMBER',
  'LEGAL_PEC',
  'LEGAL_CONTACT_EMAIL',
  'LEGAL_PRIVACY_EMAIL',
  'LEGAL_SUPERVISORY_AUTHORITY',
];

for (const name of IDENTITY_VARS) {
  if (!config.includes(name)) {
    failures.push(`${CONFIG} does not declare ${name}`);
  }
  if (!envExample.includes(name)) {
    failures.push(`${ENV_EXAMPLE} does not document ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.error(`check-legal-placeholders: FAILED (${failures.length} problem(s))`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nThe legal surface is published as written. A placeholder or a missing ' +
      'clause is a compliance defect, not a typo — fix the document, not the check.',
  );
  process.exit(1);
}

console.log(
  `check-legal-placeholders: OK — ${PLACEHOLDERS.length} placeholder patterns, ` +
    `${REQUIRED_CLAUSES.length} required clauses, ${IDENTITY_VARS.length} identity variables`,
);
