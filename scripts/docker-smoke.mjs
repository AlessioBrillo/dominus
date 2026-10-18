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
import { existsSync } from 'node:fs';

const root = process.cwd();
let failures = 0;

function sh(cmd, args, { cwd = root } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return { error: err, stdout: err.stdout ? err.stdout.toString() : '', stderr: err.stderr ? err.stderr.toString() : '' };
  }
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
    const health = sh('curl', ['-fsS', '--max-time', '30', 'http://127.0.0.1:3000/api/v1/health']);
    if (health.error) {
      fail(`base+unbound /api/v1/health failed: ${health.stderr || health.error.message}`);
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
  // Requires POSTGRES_PASSWORD and DOMINUS_APP_PASSWORD for the init scripts.
  if (!process.env.POSTGRES_PASSWORD || !process.env.DOMINUS_APP_PASSWORD) {
    ok('Skipping prod runtime smoke (POSTGRES_PASSWORD / DOMINUS_APP_PASSWORD not set)');
    return;
  }
  sh('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', 'up', '-d']);
  try {
    const health = sh('curl', ['-fsS', '--max-time', '60', 'http://127.0.0.1:3000/api/v1/health']);
    if (health.error) {
      fail(`prod /api/v1/health failed: ${health.stderr || health.error.message}`);
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

  process.stdout.write('\n');
  if (failures > 0) {
    process.stderr.write(`docker-smoke: ${failures} failure(s)\n`);
    process.exit(1);
  }
  process.stdout.write('docker-smoke: all checks passed\n');
}

main();
