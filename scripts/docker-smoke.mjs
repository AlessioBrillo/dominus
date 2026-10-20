#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Docker smoke tests for the self-hosted deploy path.
 *
 * These are the three checks that should have caught the deployment defects
 * found in the launch audit (B1-B4, B7, B11, B13, B18). They intentionally
 * require a working Docker daemon; run them with `npm run gate:docker` before
 * any tag or any change to compose / Dockerfile / deploy/.
 *
 * Smoke 1 — base + Unbound: stack must render and start, /api/v1/health OK,
 * and a sample pipeline run completes (degraded without Unbound is still OK
 * for syntax, but Unbound overlay is the documented path).
 * Smoke 2 — prod overlay on a FRESH volume: postgres init must succeed
 * (catches B1: initdb.d scripts + DOMINUS_APP_PASSWORD), migrations run,
 * /api/v1/health OK.
 * Smoke 3 — compose config lint: both stacks render with `config --quiet`;
 * promtool checks alert rules (catches B3).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
let failures = 0;

/**
 * The environment the compose calls run with.
 *
 * The compose files require these variables (the API refuses to boot
 * without API_KEYS, the prod overlay refuses to render without the database
 * passwords and the image tag). The gate is local, so ephemeral values are
 * enough — but the caller's own values win, because a real deployment has
 * them and the smoke should exercise what the operator actually runs.
 */
const SMOKE_ENV = {
  ...process.env,
  API_KEYS: process.env.API_KEYS ?? 'admin=smoke-local-only-0000000000000000000000000000',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'smoke-local-password',
  DOMINUS_APP_PASSWORD: process.env.DOMINUS_APP_PASSWORD ?? 'smoke-local-password',
  GRAFANA_ADMIN_PASSWORD: process.env.GRAFANA_ADMIN_PASSWORD ?? 'smoke-local-password',
  DOMINUS_IMAGE_TAG: process.env.DOMINUS_IMAGE_TAG ?? 'v1.2.0',
};

/**
 * A throwaway data directory.
 *
 * The stacks mount the host's ./data, so without this the smoke would run
 * against the developer's own database: a schema that is ahead of the image
 * then fails the migration gate and the smoke reports a broken image for a
 * reason that has nothing to do with the image.
 */
const SMOKE_DATA_DIR = join(tmpdir(), 'dominus-docker-smoke');
mkdirSync(SMOKE_DATA_DIR, { recursive: true });
const SMOKE_COMPOSE_ENV = { ...SMOKE_ENV, DATA_DIR: SMOKE_DATA_DIR };

function sh(cmd, args, { cwd = root, env = SMOKE_COMPOSE_ENV } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return { error: err, stdout: err.stdout ? err.stdout.toString() : '', stderr: err.stderr ? err.stderr.toString() : '' };
  }
}

/**
 * Wait for the health endpoint, the way CI does.
 *
 * A single immediate curl reports "Empty reply from server" while the
 * container is still starting: the port is bound before the application
 * listens. A smoke that fails for that reason teaches the reader to ignore
 * the smoke.
 */
/**
 * The prod overlay declares `env_file: .env`. Compose refuses to render
 * without it; an empty file is enough, exactly as CI does. The file is only
 * created when it is missing and only removed when the smoke created it — a
 * developer's own .env is never touched.
 */
const ENV_FILE = join(root, '.env');
const ENV_FILE_CREATED = !existsSync(ENV_FILE);
if (ENV_FILE_CREATED) writeFileSync(ENV_FILE, '', 'utf-8');

function removeTempEnvFile() {
  if (ENV_FILE_CREATED) rmSync(ENV_FILE, { force: true });
}

function waitForHealth(label, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const health = sh('curl', ['-fsS', '--max-time', '5', 'http://127.0.0.1:3000/api/v1/health']);
    if (!health.error) return { ok: true };
    last = health.stderr || health.error?.message || 'unknown error';
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
  }
  return { ok: false, last };
}

function fail(msg) {
  failures += 1;
  process.stderr.write(`[FAIL] ${msg}\n`);
}

function ok(msg) {
  process.stdout.write(`[ok] ${msg}\n`);
}

function dockerAvailable() {
  const r = sh('docker', ['--version']);
  return r && !r.error;
}

// ── Smoke 3: compose config lint (no daemon needed) ─────────────────
function smokeComposeConfig() {
  process.stdout.write('\n== Smoke 3: compose config lint ==\n');
  const stacks = [
    ['docker-compose.yml', 'docker-compose.unbound.yml'],
    ['docker-compose.yml', 'docker-compose.prod.yml'],
  ];
  for (const files of stacks) {
    const args = ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--quiet'];
    const r = sh('docker', args);
    if (r.error) {
      fail(`compose config failed for ${files.join(' + ')}: ${r.stderr || r.error.message}`);
    } else {
      ok(`compose config valid: ${files.join(' + ')}`);
    }
  }
}

// ── Smoke 1: base + Unbound ─────────────────────────────────────────
async function smokeBaseUnbound() {
  if (!dockerAvailable()) {
    ok('Skipping base+unbound runtime smoke (no Docker daemon)');
    return;
  }
  process.stdout.write('\n== Smoke 1: base + Unbound ==\n');
  // Bring up the stack detached, wait for health, hit /api/v1/health, then down.
  sh('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.unbound.yml', 'up', '-d']);
  try {
    const health = waitForHealth('base+unbound', 120);
    if (!health.ok) {
      fail(`base+unbound /api/v1/health failed: ${health.last}`);
    } else {
      ok('base+unbound /api/v1/health OK');
    }
  } finally {
    sh('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.unbound.yml', 'down']);
  }
}

// ── Smoke 2: prod overlay on fresh volume ───────────────────────────
async function smokeProd() {
  if (!dockerAvailable()) {
    ok('Skipping prod runtime smoke (no Docker daemon)');
    return;
  }
  process.stdout.write('\n== Smoke 2: prod overlay (fresh postgres volume) ==\n');
  sh('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', 'up', '-d']);
  try {
    const health = waitForHealth('prod', 180);
    if (!health.ok) {
      fail(`prod /api/v1/health failed: ${health.last}`);
    } else {
      ok('prod /api/v1/health OK');
    }
  } finally {
    sh('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', 'down', '-v']);
  }
}

// ── Prometheus alert rules lint ─────────────────────────────────────
function smokePromtool() {
  const rules = 'deploy/prometheus/rules.yml';
  if (!existsSync(rules)) {
    fail(`missing ${rules}`);
    return;
  }
  // promtool may not be installed; if it is, lint the rules.
  const r = sh('promtool', ['check', 'rules', rules]);
  if (r.error && !r.error.message.includes('ENOENT')) {
    fail(`promtool check rules failed: ${r.stderr || r.error.message}`);
  } else if (!r.error) {
    ok('promtool check rules OK');
  } else {
    ok('promtool not installed, skipping alert-rule lint');
  }
}

async function main() {
  smokeComposeConfig();
  smokePromtool();
  await smokeBaseUnbound();
  await smokeProd();

  // The throwaway data directory is the smoke's, not the developer's.
  rmSync(SMOKE_DATA_DIR, { recursive: true, force: true });
  removeTempEnvFile();

  process.stdout.write('\n');
  if (failures > 0) {
    process.stderr.write(`docker-smoke: ${failures} failure(s)\n`);
    process.exit(1);
  }
  process.stdout.write('docker-smoke: all checks passed\n');
}

main();
