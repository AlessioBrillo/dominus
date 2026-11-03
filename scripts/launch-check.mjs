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
 * Two profiles, because the two editions make different promises:
 *
 *   --cloud        the managed service: an operator identity, Stripe, a
 *                  metrics token, backups, an external probe, an audit.
 *   --community    the self-hosted edition: the AGPL and the self-hosted
 *                  data flow are the documents, there is no operator
 *                  identity to publish and no subscription to sell, and
 *                  the operator of the installation is the data controller.
 *
 * The profile is detected from the environment (DATABASE_URL, AUTH_PROVIDER)
 * exactly as the server detects it, and can always be forced.
 *
 * Usage:
 *
 *   npm run launch:check -- --cloud
 *   npm run launch:check -- --community --url http://localhost:3000
 *   npm run launch:check -- --cloud --url https://… --paid \
 *     --evidence .acceptance/launch
 *
 * Exit code 0 when every required check passes, 1 when a required check fails.
 * Warnings never fail the gate: they are the things a human still has to
 * do, and the point of naming them is that they are not forgotten.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as tlsConnect } from 'node:tls';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const baseUrl =
  urlIndex >= 0 && args[urlIndex + 1] !== undefined
    ? args[urlIndex + 1].replace(/\/+$/, '')
    : undefined;
const evidenceIndex = args.indexOf('--evidence');
const evidenceDir =
  evidenceIndex >= 0 && args[evidenceIndex + 1] !== undefined
    ? args[evidenceIndex + 1]
    : undefined;
const requirePaid = args.includes('--paid');
const skipTrademark = args.includes('--skip-trademark');
const asJson = args.includes('--json');

// Contradictory flags are a usage error, not a verdict: a gate that guesses
// which edition to judge is worse than one that refuses.
if (args.includes('--community') && (args.includes('--cloud') || requirePaid)) {
  console.error('launch-check: --community cannot be combined with --cloud or --paid');
  process.exit(2);
}
if (requirePaid && skipTrademark) {
  console.error(
    'launch-check: --paid cannot be combined with --skip-trademark — the canary is a paid precondition',
  );
  process.exit(2);
}

/** Placeholders that must never be published. */
const PLACEHOLDERS = ['.example', 'changeme', 'change_me', 'change-me', 'tbd', 'todo'];

/**
 * The edition this gate is judging.
 *
 * The server infers cloud mode from DATABASE_URL or a non-env auth provider
 * (src/config.ts, detectCloudMode). The gate uses the same rule, so it
 * cannot disagree with the process it is checking. An explicit flag wins.
 */
function detectMode() {
  if (args.includes('--community')) return 'community';
  if (args.includes('--cloud')) return 'cloud';
  // A paid launch is a Cloud launch: --paid cannot silently judge the
  // community profile just because the environment looks self-hosted.
  if (requirePaid) return 'cloud';
  if (process.env.DATABASE_URL) return 'cloud';
  if (process.env.AUTH_PROVIDER !== undefined && process.env.AUTH_PROVIDER !== 'env') {
    return 'cloud';
  }
  return 'community';
}

const mode = detectMode();

const results = [];

/**
 * @param {string} group
 * @param {'pass' | 'fail' | 'warn' | 'info'} status
 * @param {string} name
 * @param {string} detail
 * @param {number} [ms]
 */
function record(group, status, name, detail, ms = 0) {
  results.push({ group, name, status, detail, ms });
}

function isPlaceholder(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '') return true;
  return PLACEHOLDERS.some((p) => normalized.includes(p));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run one check and turn a thrown error into a failed result. */
async function check(group, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    record(group, 'pass', name, detail ?? 'ok', Date.now() - started);
  } catch (err) {
    record(group, 'fail', name, err.message, Date.now() - started);
  }
}

/* ------------------------------------------------------------------ *
 * 1. The operator identity (art. 7 D.Lgs. 70/2003)
 *
 * The community edition publishes the AGPL and the self-hosted data flow,
 * not an operator identity: the person who runs the installation is the
 * controller, and the software cannot know who that is. Demanding an
 * identity from a self-hoster would be a false requirement.
 * ------------------------------------------------------------------ */
const IDENTITY_FIELDS = [
  ['LEGAL_ENTITY_NAME', 'registered name'],
  ['LEGAL_REGISTERED_ADDRESS', 'registered address'],
  ['LEGAL_VAT_ID', 'VAT identification number'],
  ['LEGAL_CONTACT_EMAIL', 'contact address'],
  ['LEGAL_PRIVACY_EMAIL', 'data protection contact'],
];

const COMPANY_ONLY_FIELDS = [
  ['LEGAL_REA_NUMBER', 'REA number'],
  ['LEGAL_PEC', 'certified electronic address'],
];

if (mode === 'cloud') {
  const fields = [...IDENTITY_FIELDS];
  if ((process.env.LEGAL_ENTITY_KIND ?? 'individual') === 'company') {
    fields.push(...COMPANY_ONLY_FIELDS);
  }
  const missingIdentity = fields.filter(([name]) => isPlaceholder(process.env[name]));
  if (missingIdentity.length === 0) {
    record('identity', 'pass', 'legal identity', 'the operator identity is complete');
  } else {
    record(
      'identity',
      'fail',
      'legal identity',
      `missing or placeholder: ${missingIdentity.map(([n, what]) => `${n} (${what})`).join(', ')}`,
    );
  }
} else {
  record(
    'identity',
    'info',
    'legal identity',
    'the community edition publishes the AGPL and the self-hosted data flow, not an operator identity',
  );
}

/* ------------------------------------------------------------------ *
 * 2. The cloud boot requirements (the server refuses to start without them)
 * ------------------------------------------------------------------ */
const metricsToken = process.env.METRICS_TOKEN;
if (mode === 'cloud') {
  if (metricsToken && !isPlaceholder(metricsToken)) {
    record('boot', 'pass', 'metrics access control', 'METRICS_TOKEN is set');
  } else {
    record(
      'boot',
      'fail',
      'metrics access control',
      'METRICS_TOKEN is not set — the server refuses to boot in cloud mode',
    );
  }
} else if (metricsToken && !isPlaceholder(metricsToken)) {
  record('boot', 'pass', 'metrics access control', 'METRICS_TOKEN is set');
} else {
  record(
    'boot',
    'info',
    'metrics access control',
    'METRICS_TOKEN is unset — the metrics endpoint is open on this deployment',
  );
}

if (process.env.TRUST_PROXY_DEPTH !== undefined) {
  record('boot', 'pass', 'proxy depth', `TRUST_PROXY_DEPTH=${process.env.TRUST_PROXY_DEPTH}`);
} else if (requirePaid) {
  record(
    'boot',
    'fail',
    'proxy depth',
    'TRUST_PROXY_DEPTH is unset — behind a proxy every per-IP rate limit is keyed on the proxy',
  );
} else {
  record(
    'boot',
    'warn',
    'proxy depth',
    'TRUST_PROXY_DEPTH is unset — behind a proxy every per-IP rate limit is keyed on the proxy',
  );
}

/* ------------------------------------------------------------------ *
 * 3. Billing: the paid surface must be complete or switched off
 * ------------------------------------------------------------------ */
if (mode === 'cloud') {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey && !isPlaceholder(stripeKey)) {
    const missingPrices = [
      'STRIPE_PRICE_ID_PRO_MONTHLY',
      'STRIPE_PRICE_ID_PRO_YEARLY',
      'STRIPE_PRICE_ID_TEAM_MONTHLY',
      'STRIPE_PRICE_ID_TEAM_YEARLY',
    ].filter((name) => isPlaceholder(process.env[name]));
    if (missingPrices.length === 0) {
      record('billing', 'pass', 'billing configuration', 'Stripe is configured with the published plans');
    } else {
      record('billing', 'fail', 'billing configuration', `missing price ids: ${missingPrices.join(', ')}`);
    }
    if (isPlaceholder(process.env.STRIPE_WEBHOOK_SECRET)) {
      record(
        'billing',
        'fail',
        'billing webhooks',
        'STRIPE_WEBHOOK_SECRET is missing — subscription state would never update',
      );
    } else {
      record('billing', 'pass', 'billing webhooks', 'the webhook secret is set');
    }
  } else if (requirePaid) {
    record(
      'billing',
      'fail',
      'billing configuration',
      'the paid tiers are enabled (--paid) but Stripe is not configured',
    );
  } else {
    record(
      'billing',
      'warn',
      'billing configuration',
      'Stripe is not configured: the paid surface fails closed (BILLING_NOT_CONFIGURED)',
    );
  }
} else {
  record(
    'billing',
    'info',
    'billing configuration',
    'the community edition has no billing surface',
  );
}

/* ------------------------------------------------------------------ *
 * 4. Backups and alerting
 * ------------------------------------------------------------------ */
if (process.env.BACKUP_DIR && !isPlaceholder(process.env.BACKUP_DIR)) {
  const retention = Number(process.env.BACKUP_RETENTION_DAYS ?? '0');
  if (retention > 0) {
    record('operations', 'pass', 'backups', `BACKUP_DIR is set, retention ${retention} days`);
  } else if (requirePaid) {
    record('operations', 'fail', 'backups', 'BACKUP_RETENTION_DAYS is zero — nothing would be retained');
  } else {
    record('operations', 'warn', 'backups', 'BACKUP_RETENTION_DAYS is zero — nothing would be retained');
  }
} else if (mode === 'cloud' || requirePaid) {
  record('operations', 'fail', 'backups', 'BACKUP_DIR is not set');
} else {
  record('operations', 'warn', 'backups', 'BACKUP_DIR is not set — back up the SQLite file yourself');
}

const notifierWebhook = process.env.NOTIFIER_WEBHOOK_URL;
if (notifierWebhook && !isPlaceholder(notifierWebhook)) {
  record('operations', 'pass', 'job notifications', 'the dead-letter notification webhook is set');
} else if (requirePaid) {
  record('operations', 'fail', 'job notifications', 'NOTIFIER_WEBHOOK_URL is not set — dead-letter jobs alert nobody');
} else {
  record('operations', 'warn', 'job notifications', 'NOTIFIER_WEBHOOK_URL is not set — dead-letter jobs alert nobody');
}

const alertmanagerPath = join(root, 'deploy', 'prometheus', 'alertmanager.yml');
if (existsSync(alertmanagerPath)) {
  const text = readFileSync(alertmanagerPath, 'utf-8');
  if (text.includes('example.com/your-webhook')) {
    record(
      'operations',
      requirePaid ? 'fail' : 'warn',
      'alerting',
      'the Alertmanager configuration still points at the placeholder webhook — a compose-only deployment alerts nowhere',
    );
  } else {
    record('operations', 'pass', 'alerting', 'the Alertmanager webhook has been replaced');
  }
}

/* ------------------------------------------------------------------ *
 * 4b. The external probe
 *
 * Prometheus, Alertmanager and Grafana run on the app node. An app-node
 * outage therefore takes the alerting with it: the monitor that would
 * report the outage is down in the same failure. The SLA measures
 * availability with an external probe, and until that probe exists the
 * figure is an intention rather than a measurement.
 * ------------------------------------------------------------------ */
const externalProbe = process.env.EXTERNAL_PROBE_URL;
if (externalProbe && !isPlaceholder(externalProbe)) {
  record('operations', 'pass', 'external monitoring', 'the availability probe is configured');
} else if (requirePaid) {
  record(
    'operations',
    'fail',
    'external monitoring',
    'EXTERNAL_PROBE_URL is not set — a paid customer is promised a measured availability, and the measurement has to exist',
  );
} else if (mode === 'cloud') {
  record(
    'operations',
    'warn',
    'external monitoring',
    'EXTERNAL_PROBE_URL is not set — the app node’s own monitor cannot report the app node’s outage',
  );
} else {
  record('operations', 'info', 'external monitoring', 'the community edition has no availability SLA');
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
  record('security', 'pass', 'security audit', `the third-party review is on file (${externalAudit})`);
} else if (requirePaid) {
  record(
    'security',
    'fail',
    'security audit',
    'no third-party security review on file — the decision on record is that it happens before the paid launch',
  );
} else if (mode === 'cloud') {
  record('security', 'warn', 'security audit', 'no third-party security review on file yet');
} else {
  record('security', 'info', 'security audit', 'the community edition is not covered by the paid-launch decision');
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
      record('legal', 'warn', 'legal text', `the legal documents were last updated ${ageDays} days ago`);
    } else {
      record('legal', 'pass', 'legal text', `last updated ${updatedAt[1]}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 7. The canonical origin
 *
 * The public pages build their canonical URL, their Open Graph metadata
 * and their sitemap from PUBLIC_APP_URL when it is set, and from the
 * request origin otherwise. A deployment that is exposed to the internet
 * must say who it is: without PUBLIC_APP_URL a self-hosted instance
 * publishes canonicals that point at dominus.app, which is both wrong and
 * invisible to every test that does not look at the rendered HTML.
 * ------------------------------------------------------------------ */
const publicAppUrl = process.env.PUBLIC_APP_URL;
const expectedHost = baseUrl ? new URL(baseUrl).host : null;

if (publicAppUrl && !isPlaceholder(publicAppUrl)) {
  let configuredHost = null;
  try {
    configuredHost = new URL(publicAppUrl).host;
  } catch {
    record('public', 'fail', 'canonical origin', 'PUBLIC_APP_URL is not a valid URL');
  }
  if (configuredHost) {
    if (expectedHost && configuredHost !== expectedHost) {
      record(
        'public',
        'fail',
        'canonical origin',
        `PUBLIC_APP_URL points at ${configuredHost} but the deployment answers at ${expectedHost} — canonical, Open Graph and sitemap would be wrong`,
      );
    } else {
      record('public', 'pass', 'canonical origin', `PUBLIC_APP_URL is ${publicAppUrl}`);
    }
  }
} else if (expectedHost && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(expectedHost)) {
  record(
    'public',
    'fail',
    'canonical origin',
    'PUBLIC_APP_URL is not set on a public deployment — canonical URLs, Open Graph metadata and the sitemap would point at dominus.app',
  );
} else if (expectedHost) {
  record('public', 'pass', 'canonical origin', 'loopback deployment: the request origin is the canonical origin');
} else {
  record('public', 'warn', 'canonical origin', 'PUBLIC_APP_URL is not set');
}

/* ------------------------------------------------------------------ *
 * 8. The live deployment (optional)
 * ------------------------------------------------------------------ */
async function probe(
  path,
  { accept = 'application/json', method = 'GET', body, redirect = 'follow' } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect,
    headers: {
      Accept: accept,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json, headers: response.headers, url: response.url };
}

function header(headers, name) {
  return headers.get(name) ?? '';
}

/** The certificate the deployment actually serves, not the one it claims. */
function certificateInfo(host, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      const protocol = socket.getProtocol();
      socket.end();
      if (!cert || !cert.valid_to) {
        reject(new Error('the server did not present a certificate'));
        return;
      }
      const validTo = new Date(cert.valid_to);
      resolve({
        validTo,
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
        protocol,
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TLS handshake timed out'));
    });
    socket.on('error', reject);
  });
}

const siteOrigin = (() => {
  if (publicAppUrl && !isPlaceholder(publicAppUrl)) {
    try {
      return new URL(publicAppUrl).origin;
    } catch {
      /* fall through */
    }
  }
  if (baseUrl) return new URL(baseUrl).origin;
  return undefined;
})();

if (baseUrl) {
  const parsed = new URL(baseUrl);
  const isHttps = parsed.protocol === 'https:';

  if (isHttps) {
    await check('public', 'TLS certificate', async () => {
      const info = await certificateInfo(parsed.hostname, Number(parsed.port) || 443);
      assert(info.daysLeft > 0, `the certificate expired on ${info.validTo.toISOString()}`);
      if (info.daysLeft <= 14) {
        record(
          'public',
          'warn',
          'TLS certificate expiry',
          `the certificate expires in ${info.daysLeft} day(s)`,
        );
      }
      assert(
        info.protocol === 'TLSv1.2' || info.protocol === 'TLSv1.3',
        `the server negotiated ${info.protocol}`,
      );
      return `valid until ${info.validTo.toISOString()} (${info.daysLeft} days), ${info.protocol}`;
    });

    await check('public', 'HTTP to HTTPS redirect', async () => {
      const httpUrl = `http://${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}/api/health`;
      const response = await fetch(httpUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      assert(
        [301, 302, 307, 308].includes(response.status),
        `expected a redirect, got ${response.status}`,
      );
      const location = response.headers.get('location') ?? '';
      assert(location.startsWith('https://'), `the redirect does not lead to HTTPS (${location})`);
      return `${response.status} → ${location}`;
    });

    await check('public', 'HTTPS security headers', async () => {
      const response = await probe('/api/health', { accept: 'application/json' });
      const hsts = header(response.headers, 'strict-transport-security');
      const csp = header(response.headers, 'content-security-policy');
      assert(hsts !== '', 'Strict-Transport-Security is missing');
      assert(csp !== '', 'Content-Security-Policy is missing');
      return 'HSTS and CSP are present';
    });
  }

  await check('live', 'health endpoint', async () => {
    const response = await probe('/api/health');
    assert(response.status === 200, `GET /api/health answered ${response.status}`);
    assert(response.json?.status === 'ok', 'the health body does not say status=ok');
    return 'the process and its database answer';
  });

  await check('live', 'legal documents', async () => {
    const response = await probe('/public/legal');
    assert(response.status === 200, `GET /public/legal answered ${response.status}`);
    const documents = response.json?.documents ?? [];
    assert(Array.isArray(documents) && documents.length === 3, `expected 3 documents, got ${documents.length}`);
    const slugs = documents.map((d) => d.slug).sort();
    assert(
      slugs.join(',') === 'legal-notice,privacy,terms',
      `unexpected documents: ${slugs.join(', ')}`,
    );
    assert(
      response.json?.mode === mode,
      `the deployment publishes the ${response.json?.mode} documents but this gate is judging ${mode}`,
    );
    return `${slugs.join(', ')} (${mode})`;
  });

  await check('live', 'legal footer', async () => {
    const response = await probe('/public/domain/example.com', { accept: 'text/html' });
    assert(response.status === 200, `GET /public/domain/example.com answered ${response.status}`);
    assert(
      response.text.includes('data-legal-footer'),
      'the public page does not carry the legal footer',
    );
    return 'the public page carries the legal footer';
  });

  await check('live', 'canonical origin (rendered)', async () => {
    const response = await probe('/public/domain/example.com', { accept: 'text/html' });
    assert(response.status === 200, `GET /public/domain/example.com answered ${response.status}`);
    const match = /<link rel="canonical" href="([^"]+)"/.exec(response.text);
    assert(match !== null, 'the page carries no canonical link');
    // The application renders a root-relative canonical (`/public/domain/…`),
    // which is valid HTML and valid SEO: resolve it against the deployment
    // origin instead of demanding an absolute href.
    const canonical = new URL(match[1], siteOrigin ?? parsed.origin);
    const expected = siteOrigin ? new URL(siteOrigin).host : parsed.host;
    assert(
      canonical.host === expected,
      `the canonical points at ${canonical.host}, the deployment answers at ${expected}`,
    );
    return canonical.toString();
  });

  await check('live', 'public HTML and JSON agree', async () => {
    const json = await probe('/public/domain/example.com');
    const html = await probe('/public/domain/example.com', { accept: 'text/html' });
    assert(json.status === 200, `JSON answered ${json.status}`);
    assert(html.status === 200, `HTML answered ${html.status}`);
    assert(json.json?.domain === 'example.com', 'the JSON does not name example.com');
    const expectedValue = json.json?.score?.expectedValue;
    assert(typeof expectedValue === 'number', 'the JSON carries no expectedValue');
    const rendered = `€${expectedValue.toFixed(0)}`;
    assert(
      html.text.includes(rendered),
      `the HTML does not carry the expected value the JSON reports (${rendered})`,
    );
    return `expected value ${rendered} in both representations`;
  });

  await check('live', 'sitemap and robots', async () => {
    const robots = await probe('/public/robots.txt', { accept: 'text/plain' });
    assert(robots.status === 200, `GET /public/robots.txt answered ${robots.status}`);
    const sitemapUrl = `${siteOrigin ?? parsed.origin}/public/sitemap.xml`;
    assert(robots.text.includes(`Sitemap: ${sitemapUrl}`), `robots.txt does not point at ${sitemapUrl}`);
    const sitemap = await probe('/public/sitemap.xml', { accept: 'application/xml' });
    assert(sitemap.status === 200, `GET /public/sitemap.xml answered ${sitemap.status}`);
    assert(sitemap.text.includes('<urlset'), 'the sitemap is not a urlset');
    const origin = siteOrigin ?? parsed.origin;
    // An empty sitemap is a valid sitemap: a fresh deployment has no public
    // scores yet. Judge the entries that exist, not the presence of entries.
    const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
      m[1].replace(/&amp;/g, '&'),
    );
    for (const loc of locs) {
      assert(
        loc === origin || loc.startsWith(`${origin}/`),
        `the sitemap lists ${loc}, outside the deployment origin ${origin}`,
      );
    }
    return locs.length === 0
      ? `${sitemapUrl} (empty: no public scores yet)`
      : `${sitemapUrl} (${locs.length} entr${locs.length === 1 ? 'y' : 'ies'})`;
  });

  await check('live', 'public surface headers', async () => {
    const response = await probe('/public/domain/example.com', { accept: 'text/html' });
    assert(
      header(response.headers, 'x-content-type-options') === 'nosniff',
      'X-Content-Type-Options is not nosniff',
    );
    assert(
      header(response.headers, 'content-security-policy') !== '',
      'Content-Security-Policy is missing',
    );
    const rateLimited = [...response.headers.keys()].some((k) => k.toLowerCase().startsWith('ratelimit'));
    assert(rateLimited, 'the public response carries no rate-limit header');
    return 'nosniff, CSP and rate-limit headers are present';
  });

  await check('live', 'public input validation', async () => {
    const response = await probe('/public/scores', {
      method: 'POST',
      body: { domain: 'not a domain' },
    });
    assert(response.status === 400, `POST /public/scores with an invalid domain answered ${response.status}`);
    assert(response.json?.error?.code === 'INVALID_DOMAIN', 'the error code is not INVALID_DOMAIN');
    return 'an invalid domain is refused without being scored';
  });

  await check('live', 'data rights endpoints', async () => {
    const exported = await probe('/api/v1/tenant/export');
    assert(
      exported.status === 401 || exported.status === 403,
      `GET /api/v1/tenant/export answered ${exported.status}`,
    );
    const erased = await probe('/api/v1/tenant', { method: 'DELETE' });
    assert(
      erased.status === 401 || erased.status === 403,
      `DELETE /api/v1/tenant answered ${erased.status}`,
    );
    return 'export and erasure exist and require authentication';
  });

  if (!skipTrademark) {
    await check('live', 'trademark gate (live canary)', async () => {
      // The registers are live third-party systems. A wrong verdict is
      // asked again before the gate fails: the public endpoint caches, so
      // the second answer proves what the deployment will keep serving.
      // A persistent fail-open still fails, and the detail names every
      // answer rather than hiding the first one.
      const ask = async (domain) => {
        const response = await probe(`/public/domain/${domain}`);
        assert(response.status === 200, `${domain} answered ${response.status}`);
        return response.json?.trademark?.verdict;
      };
      const confirm = async (domain, expected) => {
        const answers = [await ask(domain)];
        if (answers[0] !== expected) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          answers.push(await ask(domain));
        }
        assert(
          answers.at(-1) === expected,
          `${domain} verdict is '${answers.at(-1)}', expected '${expected}' (answered ${answers.join(', ')})`,
        );
        return answers;
      };

      const blocked = await confirm('nike.com', 'blocked');
      const clear = await confirm('vintagecoffee.com', 'clear');
      const retried = blocked.length > 1 || clear.length > 1;
      return `nike.com is blocked, vintagecoffee.com is clear — no verdict is unverified${
        retried ? ' (one verdict was confirmed on a second attempt)' : ''
      }`;
    });
  } else {
    record('live', 'info', 'trademark gate (live canary)', 'skipped with --skip-trademark');
  }
} else {
  record('live', 'info', 'deployment', 'not probed — pass --url https://… to check a live deployment');
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
const groupOrder = ['identity', 'boot', 'billing', 'operations', 'security', 'legal', 'public', 'live'];
const statusOrder = { fail: 0, warn: 1, pass: 2, info: 3 };
results.sort(
  (a, b) =>
    groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
    statusOrder[a.status] - statusOrder[b.status],
);

const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
if (!asJson) {
  let currentGroup = null;
  for (const result of results) {
    if (result.group !== currentGroup) {
      currentGroup = result.group;
      console.log(`\n${currentGroup}`);
    }
    console.log(`  [${icon[result.status]}] ${result.name}: ${result.detail}`);
  }
}

const failures = results.filter((r) => r.status === 'fail');
const warnings = results.filter((r) => r.status === 'warn');
const passes = results.filter((r) => r.status === 'pass');

const summary = {
  mode,
  paid: requirePaid,
  url: baseUrl ?? null,
  checks: results.length,
  passed: passes.length,
  failed: failures.length,
  warnings: warnings.length,
  result: failures.length === 0 ? 'pass' : 'fail',
};

/* ------------------------------------------------------------------ *
 * Evidence
 *
 * The launch checklist asks for evidence, and evidence that lives in a
 * terminal scrollback is not evidence. The file is written even when the
 * gate fails: a failed rehearsal is the most useful artifact it produces.
 * Secret values are never echoed — the checks record "is set", not what.
 * ------------------------------------------------------------------ */
function version() {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function commit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

if (evidenceDir) {
  const now = new Date().toISOString();
  const versionString = version();
  const commitString = commit();
  const basename = `launch-evidence-${versionString}-${commitString}`;
  const payload = {
    generatedAt: now,
    version: versionString,
    commit: commitString,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    ...summary,
    checks: results,
  };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `${basename}.json`), `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [
    `# Launch evidence — ${versionString} (${commitString})`,
    '',
    `- Generated: ${now}`,
    `- Mode: ${mode}${requirePaid ? ' (paid)' : ''}`,
    `- Deployment: ${baseUrl ?? 'not probed'}`,
    `- Result: **${summary.result.toUpperCase()}** — ${passes.length} passed, ${failures.length} failed, ${warnings.length} warnings`,
    '',
    '| Group | Check | Status | Detail |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.group} | ${r.name.replaceAll('|', '\\|')} | ${icon[r.status]} | ${r.detail.replaceAll('|', '\\|')} |`,
    ),
    '',
  ];
  writeFileSync(join(evidenceDir, `${basename}.md`), lines.join('\n'));
  if (!asJson) {
    console.log(`\nevidence: ${join(evidenceDir, `${basename}.json`)}`);
    console.log(`evidence: ${join(evidenceDir, `${basename}.md`)}`);
  }
}

if (asJson) {
  console.log(JSON.stringify({ ...summary, checks: results }, null, 2));
}

if (!asJson) {
  console.log(
    `\nlaunch-check: ${results.length} check(s), ${failures.length} failed, ${warnings.length} warning(s)` +
      ` — mode ${mode}${requirePaid ? ', paid launch' : ''}` +
      (baseUrl ? '' : ' (environment and repository only — add --url to check a deployment)'),
  );
}

if (failures.length > 0) {
  if (!asJson) {
    console.error(
      '\nThis deployment is not launchable yet. The failed checks above are the ' +
        'blockers; the warnings are the things a human still has to do.',
    );
  }
  process.exit(1);
}

if (!asJson) {
  console.log(
    '\nEvery required check passed. The warnings are not blockers, but they are not done either.',
  );
}
