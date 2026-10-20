#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The launch gate.
 *
 * A deployment that is about to take money and personal data has to be
 * checkable, and "checkable" means a command that answers with exit 0 or
 * exit 1 — not a checklist in a document that nobody runs.
 *
 * Every check here corresponds to a promise that is made somewhere else:
 * the legal notice promises to identify the operator, the privacy notice
 * promises export and erasure, the SLA and the operations guide promise
 * backups and alerts, and the launch-readiness document promises a third
 * party audit before the paid tiers. This command verifies the parts of
 * those promises that can be verified mechanically, and names the ones that
 * cannot.
 *
 * Usage:
 *
 *   npm run launch:check                    # check the environment and the repository
 *   npm run launch:check -- --url https://… # also probe a live deployment
 *   npm run launch:check -- --paid          # require the paid-launch preconditions
 *
 * Exit code 0 when every check passes, 1 when a required check fails.
 * Warnings never fail the gate: they are the things a human still has to
 * do, and the point of naming them is that they are not forgotten.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const baseUrl = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
const requirePaid = args.includes('--paid');

/** Placeholders that must never be published. */
const PLACEHOLDERS = ['.example', 'changeme', 'change_me', 'change-me', 'tbd', 'todo'];

const results = [];

/**
 * @param {'pass' | 'fail' | 'warn' | 'info'} status
 * @param {string} name
 * @param {string} detail
 */
function record(status, name, detail) {
  results.push({ status, name, detail });
}

function isPlaceholder(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '') return true;
  return PLACEHOLDERS.some((p) => normalized.includes(p));
}

/* ------------------------------------------------------------------ *
 * 1. The operator identity (art. 7 D.Lgs. 70/2003)
 * ------------------------------------------------------------------ */
const IDENTITY_FIELDS = [
  ['LEGAL_ENTITY_NAME', 'registered name'],
  ['LEGAL_REGISTERED_ADDRESS', 'registered address'],
  ['LEGAL_VAT_ID', 'VAT identification number'],
  ['LEGAL_CONTACT_EMAIL', 'contact address'],
  ['LEGAL_PRIVACY_EMAIL', 'data protection contact'],
];

const missingIdentity = IDENTITY_FIELDS.filter(([name]) => isPlaceholder(process.env[name]));
if (missingIdentity.length === 0) {
  record('pass', 'legal identity', 'the operator identity is complete');
} else {
  record(
    'fail',
    'legal identity',
    `missing or placeholder: ${missingIdentity.map(([n, what]) => `${n} (${what})`).join(', ')}`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. The cloud boot requirements (the server refuses to start without them)
 * ------------------------------------------------------------------ */
const metricsToken = process.env.METRICS_TOKEN;
if (metricsToken && !isPlaceholder(metricsToken)) {
  record('pass', 'metrics access control', 'METRICS_TOKEN is set');
} else {
  record('fail', 'metrics access control', 'METRICS_TOKEN is not set — the server refuses to boot in cloud mode');
}

if (process.env.TRUST_PROXY_DEPTH !== undefined) {
  record('pass', 'proxy depth', `TRUST_PROXY_DEPTH=${process.env.TRUST_PROXY_DEPTH}`);
} else {
  record(
    'warn',
    'proxy depth',
    'TRUST_PROXY_DEPTH is unset — behind a proxy every per-IP rate limit is keyed on the proxy',
  );
}

/* ------------------------------------------------------------------ *
 * 3. Billing: the paid surface must be complete or switched off
 * ------------------------------------------------------------------ */
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (stripeKey && !isPlaceholder(stripeKey)) {
  const missingPrices = [
    'STRIPE_PRICE_ID_PRO_MONTHLY',
    'STRIPE_PRICE_ID_PRO_YEARLY',
    'STRIPE_PRICE_ID_TEAM_MONTHLY',
    'STRIPE_PRICE_ID_TEAM_YEARLY',
  ].filter((name) => isPlaceholder(process.env[name]));
  if (missingPrices.length === 0) {
    record('pass', 'billing configuration', 'Stripe is configured with the published plans');
  } else {
    record('fail', 'billing configuration', `missing price ids: ${missingPrices.join(', ')}`);
  }
  if (isPlaceholder(process.env.STRIPE_WEBHOOK_SECRET)) {
    record('fail', 'billing webhooks', 'STRIPE_WEBHOOK_SECRET is missing — subscription state would never update');
  } else {
    record('pass', 'billing webhooks', 'the webhook secret is set');
  }
} else {
  record(
    'warn',
    'billing configuration',
    'Stripe is not configured: the paid surface fails closed (BILLING_NOT_CONFIGURED)',
  );
}

/* ------------------------------------------------------------------ *
 * 4. Backups and alerting
 * ------------------------------------------------------------------ */
if (process.env.BACKUP_DIR && !isPlaceholder(process.env.BACKUP_DIR)) {
  const retention = Number(process.env.BACKUP_RETENTION_DAYS ?? '0');
  if (retention > 0) {
    record('pass', 'backups', `BACKUP_DIR=${process.env.BACKUP_DIR}, retention ${retention} days`);
  } else {
    record('fail', 'backups', 'BACKUP_RETENTION_DAYS is zero — nothing would be retained');
  }
} else {
  record('fail', 'backups', 'BACKUP_DIR is not set');
}

const notifierWebhook = process.env.NOTIFIER_WEBHOOK_URL;
if (notifierWebhook && !isPlaceholder(notifierWebhook)) {
  record('pass', 'job notifications', 'the dead-letter notification webhook is set');
} else {
  record('warn', 'job notifications', 'NOTIFIER_WEBHOOK_URL is not set — dead-letter jobs alert nobody');
}

const alertmanagerPath = join(root, 'deploy', 'prometheus', 'alertmanager.yml');
if (existsSync(alertmanagerPath)) {
  const text = readFileSync(alertmanagerPath, 'utf-8');
  if (text.includes('example.com/your-webhook')) {
    record(
      'warn',
      'alerting',
      'the Alertmanager configuration still points at the placeholder webhook — a compose-only deployment alerts nowhere',
    );
  } else {
    record('pass', 'alerting', 'the Alertmanager webhook has been replaced');
  }
}

/* ------------------------------------------------------------------ *
 * 5. The third-party security audit (a decision on record: before the paid launch)
 * ------------------------------------------------------------------ */
const securityDir = join(root, 'docs', 'security');
const auditFiles = existsSync(securityDir)
  ? readdirSync(securityDir).filter((f) => /^audit-.*\.md$/.test(f))
  : [];
const externalAudit = auditFiles.find((f) => /external|third-party/i.test(f));
if (externalAudit) {
  record('pass', 'security audit', `the third-party review is on file (${externalAudit})`);
} else if (requirePaid) {
  record(
    'fail',
    'security audit',
    'no third-party security review on file — the decision on record is that it happens before the paid launch',
  );
} else {
  record('warn', 'security audit', 'no third-party security review on file yet');
}

/* ------------------------------------------------------------------ *
 * 6. The legal text on file
 * ------------------------------------------------------------------ */
const legalContentPath = join(root, 'src', 'services', 'legal-content.ts');
if (existsSync(legalContentPath)) {
  const text = readFileSync(legalContentPath, 'utf-8');
  const updatedAt = /LEGAL_DOCUMENTS_UPDATED_AT = '(\d{4}-\d{2}-\d{2})'/.exec(text);
  if (updatedAt) {
    const ageDays = Math.floor((Date.now() - Date.parse(updatedAt[1])) / 86_400_000);
    if (ageDays > 365) {
      record('warn', 'legal text', `the legal documents were last updated ${ageDays} days ago`);
    } else {
      record('pass', 'legal text', `last updated ${updatedAt[1]}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 7. The live deployment (optional)
 * ------------------------------------------------------------------ */
async function probe(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  return response;
}

if (baseUrl) {
  try {
    const legal = await probe('/public/legal');
    if (legal.status === 200) {
      const body = await legal.json();
      const slugs = (body?.documents ?? []).map((d) => d.slug).sort().join(', ');
      record('pass', 'legal documents (live)', `served: ${slugs}`);
    } else {
      record('fail', 'legal documents (live)', `GET /public/legal answered ${legal.status}`);
    }

    const footer = await fetch(`${baseUrl}/public/robots.txt`);
    const page = await fetch(`${baseUrl}/public/domain/example.com`, {
      headers: { Accept: 'text/html' },
    });
    if (page.status === 200) {
      const html = await page.text();
      if (html.includes('data-legal-footer')) {
        record('pass', 'legal footer (live)', 'the public page carries the legal footer');
      } else {
        record('fail', 'legal footer (live)', 'the public page does not carry the legal footer');
      }
    } else {
      record('warn', 'legal footer (live)', `the public page answered ${page.status} (${footer.status} for robots.txt)`);
    }

    const exportProbe = await probe('/api/v1/tenant/export');
    if (exportProbe.status === 401 || exportProbe.status === 403) {
      record('pass', 'data rights (live)', 'the export endpoint exists and requires authentication');
    } else if (exportProbe.status === 404) {
      record('fail', 'data rights (live)', 'the export endpoint does not exist on this deployment');
    } else {
      record('warn', 'data rights (live)', `the export endpoint answered ${exportProbe.status}`);
    }
  } catch (err) {
    record('fail', 'deployment', `could not reach ${baseUrl}: ${err.message}`);
  }
} else {
  record('info', 'deployment', 'not probed — pass --url https://… to check a live deployment');
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
const order = { fail: 0, warn: 1, pass: 2, info: 3 };
results.sort((a, b) => order[a.status] - order[b.status]);

const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
for (const result of results) {
  console.log(`[${icon[result.status]}] ${result.name}: ${result.detail}`);
}

const failures = results.filter((r) => r.status === 'fail');
const warnings = results.filter((r) => r.status === 'warn');

console.log(
  `\nlaunch-check: ${results.length} check(s), ${failures.length} failed, ${warnings.length} warning(s)` +
    (baseUrl ? '' : ' (environment and repository only — add --url to check a deployment)'),
);

if (failures.length > 0) {
  console.error(
    '\nThis deployment is not launchable yet. The failed checks above are the ' +
      'blockers; the warnings are the things a human still has to do.',
  );
  process.exit(1);
}

console.log('\nEvery required check passed. The warnings are not blockers, but they are not done either.');
