#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The launch rehearsal.
 *
 * `launch:check` judges a deployment; this command CREATES one, runs the
 * gate against it, and writes the evidence — with no cloud credentials, no
 * domain and no spend. It is the dress rehearsal for the staging phase:
 * the same command, with `--url`, runs against the real deployment the day
 * the infrastructure exists.
 *
 * What it does, in order:
 *
 *   1. brings up the production-parity Cloud topology with the acceptance
 *      suite (PostgreSQL + RLS + Redis + api/worker/scheduler, images built
 *      from the working tree);
 *   2. runs `launch:check --cloud --url <stack>` with a complete fixture
 *      environment, so every environment check has something to judge;
 *   3. exercises the public surface the way a stranger would: legal
 *      documents, canonical origin, HTML/JSON parity, robots, sitemap,
 *      security headers, input validation, data-rights endpoints and the
 *      live trademark canary;
 *   4. writes `launch-evidence-<version>-<sha>.json` and `.md`;
 *   5. tears the stack down, unless `--keep` is given.
 *
 * What it deliberately does not prove (and the evidence names it):
 * Hetzner, Let's Encrypt, Backblaze B2, DNS, Stripe Tax and the OIDC
 * provider need real accounts; the point-in-time recovery needs a real base
 * backup and a WAL archive (`restore-drill --pg-restore`). Those are the
 * staging phase's job, and the runbook is docs/deployment/first-apply.md.
 *
 * Usage:
 *
 *   npm run launch:rehearse                     # local production-parity stack
 *   npm run launch:rehearse -- --skip-build     # reuse the images
 *   npm run launch:rehearse -- --keep           # leave the stack up
 *   npm run launch:rehearse -- --with-ui        # also run the browser smokes
 *   npm run launch:rehearse -- --with-pitr --pitr-base <dir> --pitr-wal <dir> \
 *     --pitr-expect-rows schema_migrations:57   # the recovery drill
 *   npm run launch:rehearse -- --url https://staging.example \
 *     --evidence .acceptance/launch             # judge a real deployment
 *
 * Exit code 0 = the rehearsal is green.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Every value that follows an occurrence of `name` (repeatable flags). */
function argValues(name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1] !== undefined) values.push(args[i + 1]);
  }
  return values;
}

const explicitUrl = argValue('--url');
const port = Number(process.env.ACCEPTANCE_PORT ?? '3210');
const targetUrl = explicitUrl === undefined ? `http://127.0.0.1:${port}` : explicitUrl.replace(/\/+$/, '');
const evidenceDir = argValue('--evidence') ?? join('.acceptance', 'launch');
const skipBuild = args.includes('--skip-build');
const keep = args.includes('--keep');
const skipTrademark = args.includes('--skip-trademark');
const skipAcceptance = explicitUrl !== undefined || args.includes('--skip-acceptance');
const withUi = args.includes('--with-ui');
const withPitr = args.includes('--with-pitr');
const pitrBase = argValue('--pitr-base');
const pitrWal = argValue('--pitr-wal');
const pitrTargetTime = argValue('--pitr-target-time');
const pitrExpectRows = argValues('--pitr-expect-rows');

const COMPOSE_FILES = ['-f', 'docker-compose.acceptance.yml', '-f', 'docker-compose.unbound.yml'];

// The acceptance compose file interpolates these; the suite assembles the
// same throwaway values at run time (scripts/acceptance/cloud-acceptance.mjs).
// The rehearsal must use them for the teardown too, or `docker compose down`
// fails on the missing variables and leaves the stack running.
const COMPOSE_ENV = {
  ...process.env,
  ACCEPTANCE_POSTGRES_PASSWORD: 'acceptance-local-password',
  ACCEPTANCE_APP_PASSWORD: 'acceptance-local-password',
  ACCEPTANCE_APP_DATABASE_URL:
    'postgresql://dominus_app:acceptance-local-password@postgres:5432/dominus',
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\nlaunch-rehearse: FAIL — ${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * The fixture environment
 *
 * These are the values the acceptance stack already runs with (see
 * docker-compose.acceptance.yml). They are test-shaped, not credentials:
 * the Stripe key is a placeholder, the identity is a lab, and nothing
 * leaves the machine. The launch gate is judged against them so that the
 * rehearsal proves the CODE, not the operator's contracts.
 * ------------------------------------------------------------------ */
function fixtureEnv() {
  return {
    LEGAL_ENTITY_NAME: 'Dominus Acceptance Suite',
    LEGAL_ENTITY_KIND: 'company',
    LEGAL_REGISTERED_ADDRESS: 'Acceptance Lab, Via Test 1, 00100 Roma',
    LEGAL_VAT_ID: 'IT00000000000',
    LEGAL_REA_NUMBER: 'PR-000000',
    LEGAL_PEC: 'acceptance@example.invalid',
    LEGAL_CONTACT_EMAIL: 'acceptance@example.invalid',
    LEGAL_PRIVACY_EMAIL: 'privacy@example.invalid',
    METRICS_TOKEN: 'acceptance-metrics-token',
    BACKUP_DIR: join(root, '.acceptance', 'backups'),
    BACKUP_RETENTION_DAYS: '7',
    STRIPE_SECRET_KEY: 'acceptance-stripe-key',
    STRIPE_PUBLISHABLE_KEY: 'acceptance-stripe-publishable-key',
    STRIPE_WEBHOOK_SECRET: 'acceptance-webhook-secret',
    STRIPE_PRICE_ID_PRO_MONTHLY: 'price_acceptance_pro_monthly',
    STRIPE_PRICE_ID_PRO_YEARLY: 'price_acceptance_pro_yearly',
    STRIPE_PRICE_ID_TEAM_MONTHLY: 'price_acceptance_team_monthly',
    STRIPE_PRICE_ID_TEAM_YEARLY: 'price_acceptance_team_yearly',
    TRUST_PROXY_DEPTH: '0',
  };
}

/* ------------------------------------------------------------------ *
 * 1. The stack
 * ------------------------------------------------------------------ */
function startStack() {
  log('\nlaunch-rehearse: building and starting the Cloud topology (acceptance stack)…');
  const result = spawnSync(process.execPath, ['scripts/acceptance/cloud-acceptance.mjs'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...COMPOSE_ENV,
      KEEP_ACCEPTANCE: '1',
      ACCEPTANCE_PORT: String(port),
      // The browser smokes belong to the `cloud-acceptance` job. This
      // rehearsal judges the launch gate on the same stack, and a browser
      // timeout says nothing about the gate. `--with-ui` runs them anyway.
      ACCEPTANCE_WITH_UI: withUi ? '1' : '0',
      ...(skipBuild ? { ACCEPTANCE_SKIP_BUILD: '1' } : {}),
    },
  });
  if (result.status !== 0) {
    if (!keep) stopStack();
    fail(
      `the acceptance suite failed (exit ${result.status ?? 'signal'}) before the gate could judge the stack. ` +
        'The report is .acceptance/report.json; re-run with --keep to inspect the stack.',
    );
  }
}

function stopStack() {
  if (keep) {
    log('\nlaunch-rehearse: --keep — the stack is left running.');
    return;
  }
  log('\nlaunch-rehearse: tearing the stack down…');
  spawnSync('docker', ['compose', ...COMPOSE_FILES, 'down', '-v'], {
    cwd: root,
    stdio: 'inherit',
    env: COMPOSE_ENV,
  });
}

/* ------------------------------------------------------------------ *
 * 2. The gate
 * ------------------------------------------------------------------ */
function runLaunchCheck() {
  log(`\nlaunch-rehearse: running the launch gate against ${targetUrl}…`);
  const checkArgs = [
    'scripts/launch-check.mjs',
    '--cloud',
    '--url',
    targetUrl,
    '--evidence',
    evidenceDir,
    ...(skipTrademark ? ['--skip-trademark'] : []),
  ];
  const result = spawnSync(process.execPath, checkArgs, {
    cwd: root,
    stdio: 'inherit',
    // The fixture environment exists for the local stack. When the target
    // is a real deployment, the operator's environment is the truth: the
    // fixture must not overwrite the identity or the Stripe keys the
    // deployment actually uses.
    env: skipAcceptance ? process.env : { ...process.env, ...fixtureEnv() },
  });
  return result.status ?? 1;
}

/* ------------------------------------------------------------------ *
 * 3. The point-in-time-recovery drill (opt-in)
 *
 * The Cloud acceptance suite names PITR as out of scope: it needs a real
 * base backup and a WAL archive. The staging runbook runs it against the
 * real target; this flag runs the same drill against a local pair when the
 * operator has PostgreSQL client tools and has produced one. A missing
 * prerequisite is a SKIP with the exact command, never a silent pass.
 * ------------------------------------------------------------------ */
function runPitr() {
  if (!withPitr) {
    return { status: 'skipped', reason: 'pass --with-pitr --pitr-base <dir> --pitr-wal <dir> to run it' };
  }
  if (!pitrBase || !pitrWal) {
    return {
      status: 'skipped',
      reason: '--with-pitr requires --pitr-base and --pitr-wal (a real base backup and WAL archive)',
    };
  }
  if (pitrExpectRows.length === 0) {
    return {
      status: 'skipped',
      reason:
        '--with-pitr requires at least one --pitr-expect-rows <table>:<count>: a restore that does not compare rows is a layout check',
    };
  }
  if (!existsSync(pitrBase) || !existsSync(pitrWal)) {
    return { status: 'failed', reason: 'the base backup or the WAL archive does not exist on this host' };
  }
  log('\nlaunch-rehearse: running the point-in-time-recovery drill…');
  const result = spawnSync(
    process.execPath,
    [
      'scripts/restore-drill.mjs',
      '--pg-restore',
      '--base',
      pitrBase,
      '--wal',
      pitrWal,
      ...(pitrTargetTime === undefined ? [] : ['--target-time', pitrTargetTime]),
      ...pitrExpectRows.flatMap((expectation) => ['--expect-rows', expectation]),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  return {
    status: (result.status ?? 1) === 0 ? 'passed' : 'failed',
    reason:
      (result.status ?? 1) === 0
        ? `the base backup was restored and the rows matched (${pitrExpectRows.join(', ')})`
        : 'the restore drill failed — see the output above',
  };
}

/* ------------------------------------------------------------------ *
 * 4. The report
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
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function acceptanceSummary() {
  const reportPath = join(root, '.acceptance', 'report.json');
  if (!existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const checks = Array.isArray(report.results) ? report.results : [];
    return {
      at: report.at ?? null,
      checks: checks.length,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    };
  } catch {
    return null;
  }
}

function writeRehearsalReport(gateExit, pitr) {
  const now = new Date().toISOString();
  const versionString = version();
  const commitString = commit();
  const basename = `rehearsal-${versionString}-${commitString}`;
  const acceptance = skipAcceptance ? null : acceptanceSummary();
  const notProven = skipAcceptance
    ? [
        'the infrastructure behind the target (this run judges the live surface only)',
        'Backblaze B2 and the real PITR target',
        'Stripe Tax and the OIDC identity provider',
        'the third-party security audit',
      ]
    : [
        'the Hetzner network and Let’s Encrypt (no credentials, no domain)',
        'Backblaze B2 and the real PITR target',
        'Stripe Tax and the OIDC identity provider',
        'the third-party security audit',
      ];
  const payload = {
    generatedAt: now,
    version: versionString,
    commit: commitString,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    target: targetUrl,
    gate: gateExit === 0 ? 'pass' : 'fail',
    acceptance,
    pitr,
    notProven,
  };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `${basename}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(
    join(evidenceDir, `${basename}.md`),
    [
      `# Launch rehearsal — ${versionString} (${commitString})`,
      '',
      `- Generated: ${now}`,
      `- Target: ${targetUrl}`,
      `- Gate: **${payload.gate.toUpperCase()}**`,
      `- Acceptance: ${acceptance ? `${acceptance.passed}/${acceptance.checks} passed` : 'not available'}`,
      `- PITR: ${pitr.status}${pitr.reason ? ` — ${pitr.reason}` : ''}`,
      '',
      '## Not proven by this rehearsal',
      '',
      ...payload.notProven.map((item) => `- ${item}`),
      '',
      'The staging runbook is docs/deployment/first-apply.md.',
      '',
    ].join('\n'),
  );
  log(`\nlaunch-rehearse: evidence written to ${join(evidenceDir, `${basename}.json`)}`);
}

/* ------------------------------------------------------------------ */
async function main() {
  log('\nDOMINUS launch rehearsal');
  log(`target: ${targetUrl}`);
  log(`evidence: ${evidenceDir}`);

  if (skipAcceptance) {
    log('launch-rehearse: --url/--skip-acceptance — judging an existing deployment, not starting one');
  } else {
    startStack();
  }

  let gateExit = 1;
  try {
    gateExit = runLaunchCheck();
    const pitr = runPitr();
    // A failed recovery drill is a failed rehearsal: the report must say so
    // before it is written, or the artifact and the exit code disagree.
    if (pitr.status === 'failed') gateExit = 1;
    writeRehearsalReport(gateExit, pitr);
  } finally {
    if (!skipAcceptance) stopStack();
  }

  if (gateExit !== 0) {
    process.stderr.write('\nlaunch-rehearse: FAIL — the rehearsal is not green.\n');
    process.exit(1);
  }
  log('\nlaunch-rehearse: OK — the launch gate is green on a production-parity stack.');
}

main().catch((err) => {
  fail(err.message);
});
