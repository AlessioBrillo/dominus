#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Static supply-chain gate: every container image reference in the build
// and deployment files must be immutable (digest-pinned) or explicitly
// environment/ARG driven. Floating tags (`:latest`, bare distro tags like
// `node:22-alpine`) are rejected: they are drifting CVEs waiting on a
// retag and break reproducible rollouts (ADR-0046).
//
// Scope:
//   - Dockerfile*              — every FROM must be `@sha256:`-pinned or
//                                reference an ARG whose default is pinned.
//   - docker-compose*.yml      — external `image:` refs must carry
//                                `@sha256:`. Locally built `dominus-*`
//                                images and `${VAR}`-driven refs are exempt.
//   - deploy/*.yaml (k8s)      — image tags must be `vX.Y.Z` / `sha-<hex>` /
//                                `${VAR}` / `@sha256:`; `:latest` rejected.
//
// Usage:
//   node scripts/check-image-pins.mjs [paths...]   (default: '.')
//   exit 0 = green, exit 1 = red (unpinned reference found)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+$/;
const SHA_TAG_RE = /^sha-[0-9a-f]{7,40}$/;
const LOCAL_IMAGE_RE = /^dominus-[a-z0-9-]+:[\w.-]+$/;

export function isDockerfile(name) {
  return /^Dockerfile/.test(name);
}

export function isCompose(name) {
  return /^docker-compose.*\.ya?ml$/.test(name);
}

export function isKubernetes(dirName, name) {
  return dirName === 'deploy' && /\.ya?ml$/.test(name);
}

export function checkDockerfile(content, file) {
  const findings = [];
  content.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(#|$)/.test(line)) return;
    const fromMatch = line.match(/^\s*FROM\s+(\S+)/);
    if (fromMatch) {
      const ref = fromMatch[1];
      const digest = ref.includes('@') ? ref.split('@')[1] ?? '' : '';
      if (!ref.includes('${') && !SHA256_RE.test(digest)) {
        findings.push(
          `${file}:${i + 1}: FROM ${ref} is not pinned — use @sha256:<64-hex> or an ARG (${line.trim()})`,
        );
      }
    }
    const argMatch = line.match(/^\s*ARG\s+(\w*IMAGE\w*)(=)(\S+)/i);
    if (argMatch) {
      const [argName, value] = [argMatch[1], argMatch[3]];
      if (!value.includes('${') && !SHA256_RE.test(value.split('@').at(-1) ?? '')) {
        findings.push(
          `${file}:${i + 1}: ARG ${argName} default is not digest-pinned (${line.trim()})`,
        );
      }
    }
  });
  return findings;
}

export function findImagePins(content, file, policy) {
  const findings = [];
  content.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^\s*image:\s*(\S+)/);
    if (!m) return;
    const ref = m[1];
    if (ref.includes('${')) return;
    if (/\b@sha256:[0-9a-f]{64}\b/.test(ref)) return;
    if (LOCAL_IMAGE_RE.test(ref)) return;
    const problem = policy(ref);
    if (problem !== undefined) findings.push(`${file}:${i + 1}: ${problem} (${line.trim()})`);
  });
  return findings;
}

export const composePolicy = (ref) =>
  `image ${ref} is not pinned — add @sha256:<64-hex>, use a \${VAR} ref, or a locally built dominus-* image`;

export const k8sPolicy = (ref) => {
  const tag = ref.includes(':') ? ref.split(':').at(-1) ?? '' : '';
  if (tag !== '' && (SEMVER_TAG_RE.test(tag) || SHA_TAG_RE.test(tag))) return undefined;
  return `image ${ref} uses a floating tag in a Kubernetes manifest — pin to @sha256:<64-hex>, vX.Y.Z or sha-<commit>`;
};

function collectFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '.git' && entry !== 'node_modules' && entry !== 'frontend') walk(full);
        continue;
      }
      const dirBase = dir.split(/[\\/]/).pop() ?? '';
      if (isDockerfile(entry) || isCompose(entry) || isKubernetes(dirBase, entry)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

function scanFile(file) {
  const content = readFileSync(file, 'utf8');
  const name = file.split(/[\\/]/).at(-1) ?? '';
  const dirName = file.split(/[\\/]/).at(-2) ?? '';
  if (isDockerfile(name)) return checkDockerfile(content, file);
  if (isCompose(name)) return findImagePins(content, file, composePolicy);
  if (isKubernetes(dirName, name)) return findImagePins(content, file, k8sPolicy);
  return [];
}

export function runGuard(roots) {
  const findings = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      findings.push(`${root}: path not found`);
      continue;
    }
    const files = statSync(root).isDirectory() ? scanFilesIn(root) : [root];
    for (const file of files) findings.push(...scanFile(file));
  }
  return findings;
}

function scanFilesIn(root) {
  return collectFiles(root);
}

function main() {
  const roots = process.argv.slice(2);
  const findings = runGuard(roots.length > 0 ? roots : ['.']);
  if (findings.length > 0) {
    console.error(`check-image-pins: FAIL — ${findings.length} unpinned image reference(s)`);
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.error('check-image-pins: OK — all container image references are pinned');
}

main();