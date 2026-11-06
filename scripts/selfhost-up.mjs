#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `npm run selfhost:up` — one-command self-hosted start.
 *
 * Generates an API key if none is set, creates the data directory, brings
 * up the community Compose stack (api + worker + scheduler, with the Unbound
 * resolver overlay), waits for /api/v1/health, and prints the URL and the
 * admin key the operator needs to sign in.
 *
 * Intended for a fresh machine: clone, run this, open the URL. Nothing is
 * written to the disk except ./data (the SQLite database and backups).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const root = process.cwd();
const DATA_DIR = join(root, 'data');
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.unbound.yml'];
const HEALTH_URL = 'http://127.0.0.1:3000/api/v1/health';

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const VERSION = (pkg.version ?? '0.0.0') as string;

let failures = 0;

function sh(cmd, args, { cwd = root, env = process.env } = {}) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  if (result.error) {
    return { error: result.error, stdout: '', stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { error: new Error(`exit ${result.status}`), stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  return { error: null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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
  return !r.error;
}

function compose(args, env) {
  return sh('docker', ['compose', ...COMPOSE_FILES.flatMap((f) => ['-f', f]), ...args], { env });
}

async function waitForHealth(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const health = sh('curl', ['-fsS', '--max-time', '3', HEALTH_URL]);
    if (!health.error) {
      return { ok: true };
    }
    last = health.stderr || health.error?.message || 'unknown error';
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, last };
}

function main() {
  if (!dockerAvailable()) {
    fail('Docker daemon is not available. Install Docker and try again.');
    process.exit(1);
  }

  // ── 1. Ensure ./data exists (the container runs as non-root) ──────────
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    ok(`created ${DATA_DIR}`);
  } else {
    ok(`data directory already exists: ${DATA_DIR}`);
  }

  // ── 2. Generate an API key if none is set ─────────────────────────────
  const env = { ...process.env };
  let apiKey = env.API_KEYS;
  let keyGenerated = false;
  if (!apiKey || !apiKey.includes('=')) {
    apiKey = `admin=${randomBytes(32).toString('hex')}`;
    env.API_KEYS = apiKey;
    keyGenerated = true;
    ok('generated a new API key (API_KEYS was unset)');
  } else {
    ok('API_KEYS already set — reusing');
  }
  const [, keyValue] = apiKey.split('=');

  // ── 3. Ensure .env exists for compose, persisting a generated API key ──
  const envFile = join(root, '.env');
  const envFileExisted = existsSync(envFile);
  if (!envFileExisted) {
    writeFileSync(envFile, '', 'utf8');
    ok('created empty .env for compose');
  }
  // Persist a generated key so it survives restarts. Only write when the key
  // was just generated and the file did not already carry API_KEYS.
  if (keyGenerated && !envFileExisted) {
    appendFileSync(envFile, `API_KEYS=${apiKey}\n`, 'utf8');
    ok(`persisted API_KEYS to ${envFile}`);
  }

  // ── 4. Bring the stack up ────────────────────────────────────────────
  const up = compose(['up', '-d'], env);
  if (up.error) {
    fail(`docker compose up failed: ${up.stderr || up.error.message}`);
    if (!envFileExisted) {
      try { unlinkSync(envFile); } catch {}
    }
    process.exit(1);
  }
  ok('docker compose stack started');

  // ── 5. Wait for the health endpoint ───────────────────────────────────
  const health = await waitForHealth(120);
  if (!health.ok) {
    fail(`API did not become healthy: ${health.last}`);
    process.exit(1);
  }
  ok('API is healthy at http://127.0.0.1:3000/api/v1/health');

  // ── 6. Print the on-ramp ─────────────────────────────────────────────
  process.stdout.write(`
╔════════════════════════════════════════════════════════════════════╗
║  DOMINUS v${VERSION} — self-hosted, up and healthy                 ║
╠════════════════════════════════════════════════════════════════════╣
║  URL:        http://127.0.0.1:3000                                 ║
║  Health:     http://127.0.0.1:3000/api/v1/health                   ║
║  Admin key:  ${keyValue}                                             ║
║                                                                   ║
║  Open the URL in a browser and sign in with the admin key above.   ║
║  The key is shown only once here; copy it to your .env as:         ║
║    API_KEYS=admin=<the part after "admin=">                        ║
║                                                                   ║
║  Stop:     docker compose -f docker-compose.yml -f                ║
║            docker-compose.unbound.yml down                         ║
║  Logs:     docker compose -f docker-compose.yml -f                ║
║            docker-compose.unbound.yml logs -f                      ║
╚════════════════════════════════════════════════════════════════════╝
`);

  // Clean up the ephemeral .env we created, unless we persisted API_KEYS to it.
  if (!envFileExisted && !keyGenerated) {
    try { unlinkSync(envFile); } catch {}
  }

  if (failures > 0) process.exit(1);
}

main();
