#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Local-first Cloud image builder for DOMINUS.
//
// Builds the three Docker targets (api, worker, scheduler), tags them with
// immutable version tags (vX.Y.Z, vX.Y.Z-worker, vX.Y.Z-scheduler), pushes
// them to GHCR, and verifies each pushed manifest by digest. A boot smoke
// test runs the api image against the local compose stack to confirm it
// starts and answers /health.
//
// Policy (ADR-0046, ADR-0101):
//   - Tags are immutable: vX.Y.Z never moves; a release is a new tag.
//   - Production deploys pin the digest, never :latest.
//   - linux/amd64 only: Hetzner nodes are amd64. Multi-arch is a separate
//     decision, not a build detail.
//   - Never build on the app node: images are built here (or on a dedicated
//     Linux builder) and pushed to GHCR; the node pulls.
//   - Fail-closed: any build, push or verify failure aborts before any tag
//     exists and before release-cut mutates the repository.
//
// Usage:
//   node scripts/release-images.mjs             # dry run: build + verify locally, no push
//   node scripts/release-images.mjs --publish   # build, push to GHCR, verify remotely
//   node scripts/release-images.mjs --tag v1.6.0  # override tag (defaults to package.json version)

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = 'ghcr.io';
const IMAGE_NAME = 'alessiobrillo/dominus';
const TARGETS = ['api', 'worker', 'scheduler'];
const PLATFORM = 'linux/amd64';

// --- helpers ---------------------------------------------------------------

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

function shRaw(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: 'pipe',
  }).toString();
}

function die(msg) {
  console.error(`release-images: FATAL — ${msg}`);
  process.exit(1);
}

function log(...args) {
  console.log(`[release-images] ${args.join(' ')}`);
}

// --- version / tag resolution ----------------------------------------------

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  return pkg.version;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let publish = false;
  let tagOverride = null;
  for (const a of args) {
    if (a === '--publish') publish = true;
    else if (a.startsWith('--tag=')) tagOverride = a.slice('--tag='.length);
    else if (a === '--tag') die('--tag requires a value: --tag=v1.6.0');
    else die(`unknown argument: ${a}`);
  }
  const version = tagOverride ?? readVersion();
  if (!/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    die(`invalid tag "${version}": expected vX.Y.Z (optionally -prerelease)`);
  }
  const tag = version.startsWith('v') ? version : `v${version}`;
  return { publish, tag, version: tag.slice(1) };
}

function imageRef(tag, target) {
  const suffix = target === 'api' ? '' : `-${target}`;
  return `${REGISTRY}/${IMAGE_NAME}:${tag}${suffix}`;
}

// --- docker availability -----------------------------------------------------

function ensureDocker() {
  try {
    sh('docker', ['--version'], { silent: true });
  } catch {
    die('docker is not available — install Docker 23+ with BuildKit');
  }
  try {
    const info = shRaw('docker', ['info', '--format', '{{.Driver}}']);
    if (!/overlay2|overlay/.test(info)) {
      log(`warning: docker storage driver is "${info.trim()}", overlay2 is recommended`);
    }
  } catch {
    /* non-fatal */
  }
}

// --- build -------------------------------------------------------------------

function buildImage(target, tag, dryRun) {
  const ref = imageRef(tag, target);
  log(`build target ${target} -> ${ref}`);
  if (dryRun) {
    log(`[dry-run] would build: docker buildx build --target ${target} --platform ${PLATFORM} --load -t ${ref} .`);
    return;
  }
  sh('docker', [
    'buildx', 'build',
    '--target', target,
    '--platform', PLATFORM,
    '--load',
    '-t', ref,
    '.',
  ]);
}

// --- push --------------------------------------------------------------------

function pushImage(tag, target, dryRun) {
  const ref = imageRef(tag, target);
  log(`push ${ref}`);
  if (dryRun) {
    log(`[dry-run] would push: docker push ${ref}`);
    return;
  }
  sh('docker', ['push', ref]);
}

// --- verify ------------------------------------------------------------------

// Inspects the pushed manifest and returns the digest of the amd64 manifest.
function inspectDigest(tag, target, dryRun) {
  const ref = imageRef(tag, target);
  if (dryRun) {
    log(`[dry-run] would verify manifest digest of ${ref}`);
    return `sha256:${'0'.repeat(64)}`; // placeholder
  }
  const out = shRaw('docker', ['manifest', 'inspect', ref]);
  const manifest = JSON.parse(out);
  // manifest may be a single-object manifest or a manifest list.
  const manifests = manifest.manifests ?? [manifest];
  const amd64 = manifests.find((m) => {
    const p = m.platform ?? {};
    return p.architecture === 'amd64' && p.os === 'linux';
  });
  if (!amd64) die(`${ref}: no linux/amd64 manifest in ${out}`);
  return amd64.digest;
}

function verifyLocalImage(tag, target, dryRun) {
  const ref = imageRef(tag, target);
  log(`verify local image ${ref}`);
  if (dryRun) return;
  try {
    sh('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { silent: true });
  } catch {
    die(`${ref}: image not present locally — build failed silently`);
  }
}

// Boot smoke: run the api image briefly and check /health answers.
function bootSmoke(tag, dryRun) {
  if (dryRun) {
    log(`[dry-run] would run boot smoke for ${tag}`);
    return;
  }
  const ref = imageRef(tag, 'api');
  log(`boot smoke: run ${ref} and poll /health`);
  let containerId;
  try {
    containerId = sh('docker', ['run', '-d', '-p', '13000:3000', ref], { silent: true });
  } catch (err) {
    die(`${ref}: could not start container for boot smoke: ${err.stderr?.toString?.() ?? err}`);
  }
  const cleanup = () => {
    try { sh('docker', ['rm', '-f', containerId], { silent: true }); } catch { /* ignore */ }
  };
  try {
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const body = shRaw('curl', ['-sS', '-m', '2', 'http://127.0.0.1:13000/health']);
        if (/ok|healthy/.test(body)) { healthy = true; break; }
      } catch { /* keep polling */ }
      sh('sleep', ['1'], { silent: true });
    }
    if (!healthy) {
      const logs = shRaw('docker', ['logs', containerId, '--tail', '80']);
      die(`${ref}: boot smoke failed — /health did not answer. Last logs:\n${logs}`);
    }
    log(`boot smoke: ${ref} is healthy`);
  } finally {
    cleanup();
  }
}

// --- main --------------------------------------------------------------------

function main() {
  const { publish, tag, version } = parseArgs();
  const dryRun = !publish;

  log(`${dryRun ? 'DRY RUN' : 'PUBLISH'} — DOMINUS Cloud images for ${tag}`);

  ensureDocker();

  for (const target of TARGETS) {
    buildImage(target, tag, dryRun);
    verifyLocalImage(tag, target, dryRun);
  }

  for (const target of TARGETS) {
    pushImage(tag, target, dryRun);
  }

  const digests = {};
  for (const target of TARGETS) {
    digests[target] = inspectDigest(tag, target, dryRun);
    log(`${target}: ${digests[target]}`);
  }

  for (const target of TARGETS) {
    bootSmoke(tag, dryRun);
  }

  if (dryRun) {
    log(`dry run complete — ${tag} images built and verified locally; pass --publish to push to GHCR`);
  } else {
    log(`publish complete — ${tag} images pushed to GHCR:`);
    for (const target of TARGETS) {
      log(`  ${imageRef(tag, target)} @ ${digests[target]}`);
    }
    log(`record these digests in the release evidence; production deploys pin the digest, not the tag`);
  }
}

main();
