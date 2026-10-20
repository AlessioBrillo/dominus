#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Cloud acceptance suite: the production-parity evidence for the Cloud
// edition, produced before a paid deployment exists.
//
// What it proves, and what it does not:
//
//   PROVEN   the Cloud wiring: PostgreSQL with row-level security, the
//             non-superuser app role, Redis, the api/worker/scheduler
//             split, tenant isolation end to end (API and SQL), the Stripe
//             webhook with a signed event, the plan/usage surface, the
//             GDPR export and erasure, the metrics token, the public legal
//             surface, and the scheduler -> queue -> worker path.
//
//   NOT PROVEN
//             the OIDC/SSO login (this stack runs AUTH_PROVIDER=db, so
//             the interactive flow and the CSRF guard are out of scope —
//             they are covered by a manual smoke with a real identity
//             provider), the real DNS/RDAP/trademark providers (the
//             pipeline is not run: those providers have their own unit and
//             integration suites, and a real run belongs to staging), the
//             point-in-time recovery (a drill needs a real base backup and
//             a WAL archive: see scripts/restore-drill.mjs and the staging
//             runbook), and the Stripe tax behaviour (test-mode events
//             carry no tax engine).
//
// The boundaries are not a disclaimer: they are the list of what the
// staging phase and the audit still have to cover.
//
// Usage:
//   npm run acceptance:cloud
//   KEEP_ACCEPTANCE=1 npm run acceptance:cloud     # leave the stack up
//   ACCEPTANCE_SKIP_BUILD=1 npm run acceptance:cloud
//
// Exit code 0 = every assertion passed.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Stripe from 'stripe';

const root = process.cwd();
const PORT = Number(process.env.ACCEPTANCE_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const KEEP = process.env.KEEP_ACCEPTANCE === '1';
const SKIP_BUILD = process.env.ACCEPTANCE_SKIP_BUILD === '1';

const COMPOSE_FILES = [
  '-f',
  'docker-compose.acceptance.yml',
  '-f',
  'docker-compose.unbound.yml',
];

// The two database roles, exactly as the production split has them:
// migrations run as the owner, the application connects as the scoped
// app role. A superuser bypasses row-level security even with FORCE ROW
// LEVEL SECURITY, so an acceptance run that connected as the owner would
// prove nothing about isolation.
const OWNER_URL = 'postgresql://dominus:acceptance-local-password@postgres:5432/dominus';
const APP_ROLE = 'dominus_app';
const APP_PASSWORD = 'acceptance-local-password';
const METRICS_TOKEN = 'acceptance-metrics-token';
const STRIPE_WEBHOOK_SECRET = 'whsec_acceptance_secret';
const PRICE_PRO_MONTHLY = 'price_acceptance_pro_monthly';

const TENANT_A = 'acceptance-tenant-a';
const TENANT_B = 'acceptance-tenant-b';
const TENANT_C = 'acceptance-tenant-c';
const DOMAIN_A = 'acceptance-tenant-a.com';
const DOMAIN_B = 'acceptance-tenant-b.com';
const DOMAIN_C = 'acceptance-tenant-c.com';

const results = [];
let failures = 0;

// ── plumbing ──────────────────────────────────────────────────────────

function sh(args, { env = process.env, allowFailure = false, timeout = 180_000 } = {}) {
  try {
    return execFileSync('docker', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      // A command that never returns is a failure, not a hang: the suite
      // must always reach a verdict.
      timeout,
      killSignal: 'SIGKILL',
    }).toString();
  } catch (err) {
    if (allowFailure) {
      return { error: err, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
    }
    throw new Error(
      `docker ${args.join(' ')} failed: ${(err.stderr?.toString() ?? err.message)
        .split('\n')
        .slice(-12)
        .join('\n')}`,
    );
  }
}

function compose(args, opts = {}) {
  return sh(['compose', ...COMPOSE_FILES, ...args], opts);
}
function composeExec(service, command, { env = {}, as = null } = {}) {
  const args = ['compose', ...COMPOSE_FILES, 'exec', '-T'];
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(service, ...command);
  return sh(args, { env: { ...process.env, ...env } });
}

/** Run SQL as the database owner (bypasses RLS — that is the point). */
function sqlOwner(query) {
  return composeExec('postgres', [
    'psql',
    '-U',
    'dominus',
    '-d',
    'dominus',
    '-tAc',
    query,
  ]).trim();
}

/** Run SQL as the application role (subject to RLS — that is the point). */
function sqlAppRole(query, { tenant = null } = {}) {
  // The tenant context is a session GUC (app.tenant_id). PGOPTIONS sets it
  // for the connection, which keeps the statement itself a single query:
  // a `SET` inside the -c string would print "SET" as a result row and
  // the counts would have to be parsed out of it.
  const env = { PGPASSWORD: APP_PASSWORD };
  if (tenant) env.PGOPTIONS = `-c app.tenant_id=${tenant}`;
  return composeExec(
    'postgres',
    [
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      APP_ROLE,
      '-d',
      'dominus',
      '-tAc',
      query,
    ],
    { env },
  ).trim();
}

async function http(
  path,
  { method = 'GET', body = undefined, headers = {}, raw = false, rawBody = undefined } = {},
) {
  const res = await fetchWithRetry(path, { method, headers, body, rawBody });
  const text = await res.text();
  let json = null;
  if (!raw) {
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
  }
  return { status: res.status, text, json, headers: res.headers };
}

/**
 * The suite talks to the API through the host's port mapping, and that
 * hop is not as reliable as a loopback call: the Docker Desktop proxy
 * occasionally resets a connection that the container never saw. A
 * connection-level failure is retried; an HTTP status never is (a 401 is
 * a verdict, not a hiccup).
 */
async function fetchWithRetry(path, options, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(`${BASE_URL}${path}`, {
        method: options.method,
        headers: {
          ...(options.body !== undefined || options.rawBody !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
          ...options.headers,
        },
        body:
          options.rawBody !== undefined
            ? options.rawBody
            : options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
      });
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function api(key, path, options = {}) {
  return http(path, {
    ...options,
    headers: { ...(options.headers ?? {}), authorization: `Bearer ${key}` },
  });
}

/** The last balanced JSON object in a stream of logs and output. */
function parseLastJson(text) {
  const end = text.lastIndexOf('}');
  if (end < 0) throw new Error(`no JSON object in output: ${text.slice(-400)}`);
  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (text[i] === '}') depth += 1;
    else if (text[i] === '{') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(i, end + 1));
    }
  }
  throw new Error(`no balanced JSON object in output: ${text.slice(-400)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    process.stdout.write(`  [ok]   ${name}\n`);
  } catch (err) {
    failures += 1;
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    process.stdout.write(`  [FAIL] ${name}\n         ${err.message}\n`);
  }
}

// ── stack lifecycle ───────────────────────────────────────────────────

async function waitForApi(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const res = await http('/api/v1/health');
      if (res.status === 200) return;
      last = `status ${res.status}: ${res.text.slice(0, 200)}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(2000);
  }
  throw new Error(`the API did not become healthy in ${timeoutMs}ms (${last})`);
}

async function stackUp() {
  process.stdout.write('Building the acceptance images from the working tree…\n');
  if (!SKIP_BUILD) {
    // The build has its own budget: it installs the dependencies and
    // compiles the backend and the frontend inside the image, which is
    // minutes, not seconds. The generic timeout of the helper would kill
    // a healthy build.
    compose(['build', 'api', 'worker', 'scheduler'], { timeout: 30 * 60_000 });
  }
  process.stdout.write('Starting PostgreSQL and Redis…\n');
  compose(['up', '-d', 'postgres', 'redis']);
  process.stdout.write('Applying the migrations as the database owner…\n');
  // `docker compose run` replaces the command of the api service: the
  // image entrypoint is `node`, so this is `node dist/db/migrate-cli.js`.
  // The owner role applies the schema (the app role only gets DML on it),
  // which is the production split.
  compose([
    'run',
    '--rm',
    '-e',
    `DATABASE_URL=${OWNER_URL}`,
    'api',
    'dist/db/migrate-cli.js',
  ]);
  process.stdout.write('Starting the api, the worker and the scheduler…\n');
  compose(['up', '-d', 'api', 'worker', 'scheduler']);
  await waitForApi();
}

function stackDown() {
  if (KEEP) {
    process.stdout.write('\nKEEP_ACCEPTANCE=1: the stack is left running.\n');
    return;
  }
  process.stdout.write('\nTearing the acceptance stack down…\n');
  compose(['down', '-v'], { allowFailure: true });
}

/** The compose state and health of one service ('running healthy', …). */
function composeServiceStatus(service) {
  const out = compose(['ps', '--format', '{{.State}} {{.Health}}', service]);
  return String(out)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1) ?? 'unknown';
}

// ── the suite ─────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nDOMINUS Cloud acceptance suite\n');
  process.stdout.write(`stack: ${BASE_URL} (compose project dominus-acceptance)\n\n`);

  await stackUp();

  const keys = {};

  process.stdout.write('\nAuthentication and tenant provisioning\n');

  await check('the API is healthy', async () => {
    const res = await http('/api/v1/health');
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  await check('an operator can mint the first API key (no admin deadlock)', async () => {
    const out = composeExec('api', [
      'node',
      'dist/cli.js',
      'keys',
      'create',
      '--tenant',
      TENANT_A,
      '--name',
      'acceptance',
      '--role',
      'admin',
      '--json',
    ], { env: { LOG_LEVEL: 'error' } });
    const parsed = parseLastJson(out);
    assert(typeof parsed.key === 'string' && parsed.key.length > 16, 'no key in the CLI output');
    keys[TENANT_A] = parsed.key;
  });

  await check('the second tenant gets its own key', async () => {
    const out = composeExec('api', [
      'node',
      'dist/cli.js',
      'keys',
      'create',
      '--tenant',
      TENANT_B,
      '--name',
      'acceptance',
      '--role',
      'admin',
      '--json',
    ], { env: { LOG_LEVEL: 'error' } });
    const parsed = parseLastJson(out);
    assert(typeof parsed.key === 'string' && parsed.key.length > 16, 'no key in the CLI output');
    keys[TENANT_B] = parsed.key;
  });

  await check('a key authenticates through the login route', async () => {
    const res = await http('/api/v1/auth/login', {
      method: 'POST',
      body: { apiKey: keys[TENANT_A] },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 200)}`);
    assert(res.json?.authenticated === true, 'the login route did not authenticate the key');
    assert(res.json?.token === keys[TENANT_A], 'the login route did not return the key');
  });

  await check('an invalid key is rejected', async () => {
    const res = await http('/api/v1/auth/login', {
      method: 'POST',
      body: { apiKey: 'not-a-real-key' },
    });
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  process.stdout.write('\nTenant isolation (API level)\n');

  await check('a tenant can write its own portfolio', async () => {
    const res = await api(keys[TENANT_A], '/api/v1/portfolio', {
      method: 'POST',
      body: {
        domain: DOMAIN_A,
        tld: 'com',
        acquiredAt: '2026-01-15',
        renewalDate: '2027-01-15',
        acquisitionCost: 12,
        renewalCost: 11.99,
        registrar: 'acceptance',
      },
    });
    assert(res.status === 201, `expected 201, got ${res.status}: ${res.text.slice(0, 300)}`);
  });

  await check('the second tenant can write its own portfolio', async () => {
    const res = await api(keys[TENANT_B], '/api/v1/portfolio', {
      method: 'POST',
      body: {
        domain: DOMAIN_B,
        tld: 'com',
        acquiredAt: '2026-02-01',
        renewalDate: '2027-02-01',
        acquisitionCost: 8,
        renewalCost: 9.99,
        registrar: 'acceptance',
      },
    });
    assert(res.status === 201, `expected 201, got ${res.status}: ${res.text.slice(0, 300)}`);
  });

  await check('a tenant only lists its own rows', async () => {
    const a = await api(keys[TENANT_A], '/api/v1/portfolio');
    assert(a.status === 200, `expected 200, got ${a.status}`);
    const aDomains = (a.json?.portfolio ?? []).map((e) => e.entry?.domain ?? e.domain);
    assert(aDomains.length === 1, `expected 1 row for ${TENANT_A}, got ${aDomains.length}`);
    assert(aDomains[0] === DOMAIN_A, `expected ${DOMAIN_A}, got ${aDomains[0]}`);

    const b = await api(keys[TENANT_B], '/api/v1/portfolio');
    const bDomains = (b.json?.portfolio ?? []).map((e) => e.entry?.domain ?? e.domain);
    assert(bDomains.length === 1, `expected 1 row for ${TENANT_B}, got ${bDomains.length}`);
    assert(bDomains[0] === DOMAIN_B, `expected ${DOMAIN_B}, got ${bDomains[0]}`);
  });

  await check('a tenant cannot touch another tenant\'s row', async () => {
    const res = await api(keys[TENANT_A], `/api/v1/portfolio/${DOMAIN_B}/verdict`, {
      method: 'PATCH',
      body: { verdict: 'drop' },
    });
    assert(res.status === 404, `expected 404, got ${res.status}: ${res.text.slice(0, 200)}`);
    const still = await api(keys[TENANT_B], '/api/v1/portfolio');
    const verdict = (still.json?.portfolio ?? [])[0]?.entry?.verdict ?? (still.json?.portfolio ?? [])[0]?.verdict;
    assert(verdict !== 'drop', "the cross-tenant write went through");
  });

  process.stdout.write('\nTenant isolation (row-level security, at the database)\n');

  await check('the application role is not a superuser and does not bypass RLS', async () => {
    const out = sqlOwner(
      "SELECT rolsuper::text || '|' || rolbypassrls::text FROM pg_roles WHERE rolname = 'dominus_app'",
    );
    assert(out === 'false|false', `expected false|false, got "${out}"`);
  });

  await check('the application role sees no row without a tenant context', async () => {
    const out = sqlAppRole('SELECT count(*) FROM portfolio_entries');
    assert(out === '0', `expected 0 rows, got ${out}`);
  });

  await check('the application role sees only its own tenant\'s rows', async () => {
    const a = sqlAppRole('SELECT count(*) FROM portfolio_entries', { tenant: TENANT_A });
    const b = sqlAppRole('SELECT count(*) FROM portfolio_entries', { tenant: TENANT_B });
    assert(a === '1', `expected 1 row for ${TENANT_A}, got ${a}`);
    assert(b === '1', `expected 1 row for ${TENANT_B}, got ${b}`);
  });

  await check('the owner role sees every row (the rows really exist)', async () => {
    const out = sqlOwner('SELECT count(*) FROM portfolio_entries');
    assert(out === '2', `expected 2 rows, got ${out}`);
  });

  await check('the RLS policies are enabled and forced', async () => {
    const out = sqlOwner(
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = 'public' AND c.relname IN ('portfolio_entries','candidates') " +
        "AND c.relrowsecurity AND c.relforcerowsecurity",
    );
    assert(out === '2', `expected 2 forced-RLS tables, got ${out}`);
  });

  process.stdout.write('\nBilling\n');

  const stripe = new Stripe('sk_test_acceptance');
  const checkoutEvent = {
    id: 'evt_acceptance_checkout_1',
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: '2024-06-20',
    data: {
      object: {
        id: 'cs_acceptance_1',
        object: 'checkout.session',
        mode: 'subscription',
        customer: 'cus_acceptance',
        // The line items carry the price: without them the service falls
        // back to a Stripe API call, which would make the acceptance
        // depend on the network (and on a real Stripe account).
        line_items: {
          object: 'list',
          data: [{ object: 'item', price: { id: PRICE_PRO_MONTHLY, object: 'price' }, quantity: 1 }],
        },
        metadata: { tenantId: TENANT_A },
      },
    },
  };

  await check('a signed Stripe webhook is accepted', async () => {
    const payload = JSON.stringify(checkoutEvent);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    });
    const res = await http('/api/v1/billing/webhook', {
      method: 'POST',
      // The exact bytes: the signature is computed over them.
      rawBody: payload,
      raw: true,
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 300)}`);
  });

  await check('the paid plan is applied to the tenant', async () => {
    const res = await api(keys[TENANT_A], '/api/v1/billing');
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 200)}`);
    const plan = res.json?.subscription?.plan ?? res.json?.plan;
    assert(plan === 'pro', `expected the pro plan, got ${JSON.stringify(res.json?.subscription)}`);
  });

  await check('the same event replayed is a no-op (idempotency)', async () => {
    const payload = JSON.stringify(checkoutEvent);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    });
    const res = await http('/api/v1/billing/webhook', {
      method: 'POST',
      rawBody: payload,
      raw: true,
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 300)}`);
    const rows = sqlOwner(
      `SELECT count(*) FROM tenant_subscriptions WHERE tenant_id = '${TENANT_A}'`,
    );
    assert(rows === '1', `expected exactly one subscription row, got ${rows}`);
  });

  await check('a tampered signature is refused', async () => {
    const payload = JSON.stringify(checkoutEvent);
    const res = await http('/api/v1/billing/webhook', {
      method: 'POST',
      rawBody: payload,
      raw: true,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=deadbeef',
      },
    });
    assert(res.status === 400, `expected 400, got ${res.status}: ${res.text.slice(0, 200)}`);
  });

  process.stdout.write('\nUsage, metrics and the public surface\n');

  await check('the usage surface reports the tenant plan', async () => {
    const res = await api(keys[TENANT_A], '/api/v1/usage/limits');
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 200)}`);
  });

  await check('the metrics endpoint refuses an unauthenticated caller', async () => {
    const res = await http('/api/v1/metrics');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check('the metrics endpoint accepts the scrape token', async () => {
    const res = await http('/api/v1/metrics', {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 200)}`);
  });

  await check('the legal surface is served', async () => {
    const res = await http('/public/legal');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const docs = res.json?.documents ?? res.json;
    assert(docs, 'no legal documents in the response');
  });

  process.stdout.write('\nGDPR (art. 15 and art. 17)\n');

  await check('a tenant can be created for the erasure test', async () => {
    const out = composeExec('api', [
      'node',
      'dist/cli.js',
      'keys',
      'create',
      '--tenant',
      TENANT_C,
      '--name',
      'acceptance',
      '--role',
      'admin',
      '--json',
    ], { env: { LOG_LEVEL: 'error' } });
    keys[TENANT_C] = parseLastJson(out).key;
    const res = await api(keys[TENANT_C], '/api/v1/portfolio', {
      method: 'POST',
      body: {
        domain: DOMAIN_C,
        tld: 'com',
        acquiredAt: '2026-03-01',
        renewalDate: '2027-03-01',
        acquisitionCost: 5,
        renewalCost: 5,
        registrar: 'acceptance',
      },
    });
    assert(res.status === 201, `expected 201, got ${res.status}: ${res.text.slice(0, 300)}`);
  });

  await check('a tenant can export everything the service holds about it', async () => {
    const res = await api(keys[TENANT_C], '/api/v1/tenant/export');
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 200)}`);
    assert(res.text.includes(DOMAIN_C), 'the export does not contain the tenant domain');
  });

  await check('a tenant can erase its own data, and only its own', async () => {
    const res = await api(keys[TENANT_C], '/api/v1/tenant', {
      method: 'DELETE',
      body: { confirm: TENANT_C },
    });
    assert(res.status === 200, `expected 200, got ${res.status}: ${res.text.slice(0, 300)}`);
    const remaining = sqlOwner('SELECT count(*) FROM portfolio_entries');
    assert(remaining === '2', `the erasure touched other tenants' rows (${remaining} left)`);
  });

  await check('the erasure requires the confirmation to match', async () => {
    const res = await api(keys[TENANT_A], '/api/v1/tenant', {
      method: 'DELETE',
      body: { confirm: 'something-else' },
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  process.stdout.write('\nThe worker and the scheduler\n');

  await check('the scheduler enqueues a job the worker consumes', async () => {
    const before = Number(sqlOwner("SELECT count(*) FROM job_queue WHERE job_type = 'PRUNE'"));
    const out = composeExec('scheduler', [
      'node',
      'dist/cli.js',
      'scheduler',
      'run',
      'data-prune',
    ], { env: { LOG_LEVEL: 'error' } });
    assert(out.trim().length > 0, 'the scheduler printed nothing');

    const deadline = Date.now() + 60_000;
    let completed = 0;
    while (Date.now() < deadline) {
      completed = Number(
        sqlOwner("SELECT count(*) FROM job_queue WHERE job_type = 'PRUNE' AND status = 'completed'"),
      );
      if (completed > before) break;
      await sleep(1000);
    }
    assert(completed > before, 'the worker never completed the PRUNE job');
  });

  await check('the worker and the scheduler are alive', async () => {
    // The API does not expose the worker route when the worker is a
    // separate process (WORKER_ENABLED=false on the api container): the
    // route exists only when the API itself runs the worker. In the Cloud
    // topology the liveness of the worker and of the scheduler is their
    // own health server on 9090/9091, which is what the container
    // healthcheck probes — and what the deployment's health gate uses.
    for (const service of ['worker', 'scheduler']) {
      const status = composeServiceStatus(service);
      assert(
        status.includes('running') && status.includes('healthy'),
        `${service} is "${status}" — it must be running and healthy`,
      );
    }
  });

  // ── the browser side ───────────────────────────────────────────────
  // The fixtures are written before the UI phase: the Playwright project
  // reads the keys from here, because they exist only in the acceptance
  // database.
  const fixtures = {
    tenantA: { key: keys[TENANT_A], domain: DOMAIN_A },
    tenantB: { key: keys[TENANT_B], domain: DOMAIN_B },
    tenantC: { key: keys[TENANT_C] ?? '', domain: DOMAIN_C },
    metricsToken: METRICS_TOKEN,
  };
  const reportDir = join(root, '.acceptance');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'fixtures.json'),
    `${JSON.stringify(fixtures, null, 2)}\n`,
    'utf-8',
  );

  if (process.env.ACCEPTANCE_WITH_UI !== '0') {
    await check('the SPA works against the tenant-scoped data', async () => {
      const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
      if (!existsSync(cli)) {
        throw new Error(
          'Playwright is not installed. Run `npm ci` (and `npm run e2e:install` for the browser).',
        );
      }
      execFileSync(process.execPath, [cli, 'test', '--config=playwright.cloud.config.ts'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, ACCEPTANCE_PORT: String(PORT) },
      });
    });
  }

  // ── report ──────────────────────────────────────────────────────────
  writeFileSync(
    join(reportDir, 'report.json'),
    `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
    'utf-8',
  );

  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed\n`);
  if (failures > 0) {
    process.stdout.write(`acceptance: FAIL — ${failures} check(s) failed\n`);
    process.stdout.write(`report: ${join(reportDir, 'report.json')}\n`);
    stackDown();
    process.exit(1);
  }
  process.stdout.write('acceptance: OK — the Cloud stack behaves as specified\n');
  stackDown();
}

main().catch((err) => {
  process.stderr.write(`acceptance: FATAL — ${err.message}\n`);
  try {
    compose(['logs', '--tail', '80'], { allowFailure: true });
  } catch {
    // the logs are a courtesy, not the verdict
  }
  stackDown();
  process.exit(1);
});
