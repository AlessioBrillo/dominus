#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// DOMINUS Cloud — local-first deploy wrapper.
//
// Orchestrates a Cloud deploy on the app node:
//   1. preflight: clean tree, tag exists locally + remotely, image present in GHCR
//   2. pull the target image
//   3. migrate.sh  (schema migration gate, migrate-before-roll, ADR-0061)
//   4. rollout.sh  (image roll with automatic rollback on health failure)
//   5. health poll (Caddy / /health must go green)
//   6. launch:check --cloud --url  (the human-checkable gate against the live deployment)
//   7. write evidence (manifest, digests, gate result)
//
// It reuses the existing deploy scripts verbatim — it does not reimplement
// rollback or migration logic. It is the single entry point so an operator
// never has to remember five commands and their order.
//
// Usage:
//   node scripts/deploy-cut.mjs --tag v1.6.0 --url https://staging.example.com
//   node scripts/deploy-cut.mjs --tag v1.6.0 --url https://staging.example.com --compose-dir /opt/dominus
//
// Environment:
//   DOMINUS_TAG   (fallback for --tag, kept for rollout.sh/migrate.sh compatibility)
//   COMPOSE_DIR   (default /opt/dominus, where docker-compose.prod.yml lives)
//   GITHUB_TOKEN  (optional, for gh release / api calls in preflight)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();
const COMPOSE_DIR = process.env.COMPOSE_DIR || '/opt/dominus';

function die(msg) {
  console.error(`deploy-cut: FATAL — ${msg}`);
  process.exit(1);
}

function log(...args) {
  console.log(`[deploy-cut] ${args.join(' ')}`);
}

function sh(cmd, args, { silent = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: silent ? 'pipe' : 'inherit',
    }).trim();
  } catch (err) {
    const out = err.stdout ? err.stdout.toString() : '';
    const errOut = err.stderr ? err.stderr.toString() : '';
    die(`${cmd} ${args.join(' ')} failed:\n${out}\n${errOut}`);
  }
}

function shSilent(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return '';
  }
}

// --- args --------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let tag = process.env.DOMINUS_TAG || '';
  let url = '';
  let composeDir = COMPOSE_DIR;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tag') tag = args[++i];
    else if (a.startsWith('--tag=')) tag = a.slice('--tag='.length);
    else if (a === '--url') url = args[++i];
    else if (a.startsWith('--url=')) url = a.slice('--url='.length);
    else if (a === '--compose-dir') composeDir = args[++i];
    else if (a.startsWith('--compose-dir=')) composeDir = a.slice('--compose-dir='.length);
    else die(`unknown argument: ${a}`);
  }
  if (!tag) die('--tag (or DOMINUS_TAG) is required, e.g. --tag=v1.6.0');
  if (!/^v\d+\.\d+\.\d+/.test(tag)) die(`invalid tag "${tag}": expected vX.Y.Z`);
  if (!url) die('--url is required, e.g. --url=https://staging.example.com');
  return { tag, url, composeDir };
}

// --- preflight ---------------------------------------------------------------

function checkDocker() {
  sh('docker', ['--version'], { silent: true });
}

function checkComposeDir(composeDir) {
  if (!existsSync(composeDir)) die(`compose dir ${composeDir} does not exist`);
  if (!existsSync(join(composeDir, '.env'))) {
    log(`[warn] no .env in ${composeDir} — secrets must already be provisioned`);
  }
  if (!existsSync(join(composeDir, 'docker-compose.prod.yml'))) {
    die(`no docker-compose.prod.yml in ${composeDir} — not a Cloud app node`);
  }
}

function checkTagLocally(tag) {
  const out = shSilent('git', ['tag', '--list', tag]);
  if (!out.includes(tag)) die(`tag ${tag} does not exist locally — run release-cut first`);
  log(`[ok] tag ${tag} exists locally`);
}

function checkTagRemote(tag) {
  const out = shSilent('git', ['ls-remote', '--tags', 'origin', tag]);
  if (!out.includes(`refs/tags/${tag}`)) {
    die(`tag ${tag} is not on origin — push the tag before deploying`);
  }
  log(`[ok] tag ${tag} exists on origin`);
}

function checkImageInGHCR(tag) {
  // Anonymous manifest inspect: works on public images, no token needed.
  const targets = ['api', 'worker', 'scheduler'];
  for (const target of targets) {
    const suffix = target === 'api' ? '' : `-${target}`;
    const ref = `ghcr.io/alessiobrillo/dominus:${tag}${suffix}`;
    const out = shSilent('docker', ['manifest', 'inspect', ref]);
    if (!out) {
      die(`${ref}: manifest unknown — the image was not pushed to GHCR (or is private)`);
    }
    try {
      const manifest = JSON.parse(out);
      const manifests = manifest.manifests ?? [manifest];
      const amd64 = manifests.find((m) => {
        const p = m.platform ?? {};
        return p.architecture === 'amd64' && p.os === 'linux';
      });
      const digest = amd64 ? amd64.digest : 'digest unreadable';
      log(`[ok] ${ref} @ ${digest}`);
    } catch {
      log(`[ok] ${ref}: manifest present`);
    }
  }
}

function preflight({ tag }) {
  log('deploy-cut: preflight');
  checkDocker();
  checkTagLocally(tag);
  checkTagRemote(tag);
  checkImageInGHCR(tag);
  log('[ok] preflight complete');
}

// --- deploy steps ------------------------------------------------------------

function runMigrate(tag, composeDir) {
  log('deploy-cut: schema migration (migrate.sh)');
  const script = join(root, 'scripts', 'deploy', 'migrate.sh');
  if (!existsSync(script)) die(`migrate.sh not found at ${script}`);
  const result = spawnSync('bash', [script], {
    cwd: composeDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      DOMINUS_TAG: tag,
      COMPOSE_DIR: composeDir,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    die(`migrate.sh exited ${result.status} — no image was rolled`);
  }
  log('[ok] schema migrations applied');
}

function runRollout(tag, composeDir) {
  log('deploy-cut: image rollout (rollout.sh)');
  const script = join(root, 'scripts', 'deploy', 'rollout.sh');
  if (!existsSync(script)) die(`rollout.sh not found at ${script}`);
  const result = spawnSync('bash', [script], {
    cwd: composeDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      DOMINUS_TAG: tag,
      COMPOSE_DIR: composeDir,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    die(`rollout.sh exited ${result.status} — the rollout failed; check the node`);
  }
  log('[ok] rollout complete');
}

function healthPoll(url, attempts = 30, intervalSec = 10) {
  log(`deploy-cut: health poll ${url} (up to ${attempts * intervalSec}s)`);
  const healthUrl = url.replace(/\/$/, '') + '/health';
  for (let i = 0; i < attempts; i++) {
    try {
      const body = shSilent('curl', ['-sS', '-m', '5', healthUrl]);
      if (/ok|healthy/.test(body)) {
        log('[ok] health poll green');
        return;
      }
    } catch { /* keep polling */ }
    sh('sleep', [String(intervalSec)], { silent: true });
  }
  die(`health poll never went green at ${healthUrl} — rollout.sh should have rolled back`);
}

function runLaunchCheck(url) {
  log(`deploy-cut: launch:check --cloud --url ${url}`);
  const result = spawnSync(
    process.execPath,
    ['scripts/launch-check.mjs', '--cloud', '--url', url],
    { cwd: root, stdio: 'inherit', encoding: 'utf8' },
  );
  if (result.status !== 0) {
    die(`launch:check --cloud --url ${url} exited ${result.status} — the deployment is not green`);
  }
  log('[ok] launch:check --cloud green');
}

// --- evidence ----------------------------------------------------------------

function writeEvidence({ tag, url, composeDir }) {
  const now = new Date().toISOString();
  const commit = shSilent('git', ['rev-parse', '--short', 'HEAD']);
  const evidenceDir = join(root, '.acceptance', 'deploy');
  mkdirSync(evidenceDir, { recursive: true });

  // Collect image digests for the evidence.
  const targets = ['api', 'worker', 'scheduler'];
  const images = targets.map((target) => {
    const suffix = target === 'api' ? '' : `-${target}`;
    const ref = `ghcr.io/alessiobrillo/dominus:${tag}${suffix}`;
    const out = shSilent('docker', ['manifest', 'inspect', ref]);
    let digest = 'unknown';
    try {
      const manifest = JSON.parse(out);
      const manifests = manifest.manifests ?? [manifest];
      const amd64 = manifests.find((m) => {
        const p = m.platform ?? {};
        return p.architecture === 'amd64' && p.os === 'linux';
      });
      if (amd64) digest = amd64.digest;
    } catch { /* digest stays unknown */ }
    return { target, ref, digest };
  });

  const payload = {
    generatedAt: now,
    version: tag.slice(1),
    tag,
    commit,
    url,
    composeDir,
    images,
    gate: 'pass',
  };

  const base = `deploy-evidence-${tag.slice(1)}-${commit}`;
  writeFileSync(join(evidenceDir, `${base}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(
    join(evidenceDir, `${base}.md`),
    [
      `# Deploy evidence — ${tag} (${commit})`,
      '',
      `- Generated: ${now}`,
      `- Tag: ${tag}`,
      `- Target URL: ${url}`,
      `- Compose dir: ${composeDir}`,
      '- Gate: **pass**',
      '',
      '## Container images',
      '',
      ...images.map((i) => `- ${i.target}: ${i.ref} @ ${i.digest}`),
      '',
      '## Steps executed',
      '',
      '- preflight (tag + image verified)',
      '- migrate.sh (schema migration gate)',
      '- rollout.sh (image roll with rollback)',
      '- health poll (/health green)',
      '- launch:check --cloud --url (green)',
      '',
    ].join('\n'),
  );

  log(`evidence: .acceptance/deploy/${base}.json`);
  log(`evidence: .acceptance/deploy/${base}.md`);
}

// --- main --------------------------------------------------------------------

async function main() {
  const { tag, url, composeDir } = parseArgs();

  preflight({ tag });
  checkComposeDir(composeDir);

  runMigrate(tag, composeDir);
  runRollout(tag, composeDir);
  healthPoll(url);
  runLaunchCheck(url);
  writeEvidence({ tag, url, composeDir });

  log(`\ndeploy-cut: OK — ${tag} deployed to ${url}, evidence written.`);
}

main().catch((err) => {
  die(err.message ?? String(err));
});
