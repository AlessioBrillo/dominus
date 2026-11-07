#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Shared primitives for cutting a DOMINUS release. Used by
// `scripts/release-cut.mjs` (local, the authoritative channel) and, once
// GitHub Actions runners are healthy again, by `.github/workflows/release.yml`
// (mirror). Both call the same functions so local and CI releases can never
// diverge.
//
// The channel policy (ADR-0099): the GitHub Release is primary; npm is
// best-effort until the trusted publisher is configured. This module never
// calls `npm publish` — that stays in the workflow, behind `continue-on-error`.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Read one file from a .tgz without a tar dependency (node:tar does not ship
 *  with Node, and npm bundles no built-in reader either). */
export function readFromTarball(tgzBytes, wanted) {
  const tar = gunzipSync(tgzBytes);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    if ((prefix ? `${prefix}/${name}` : name) === wanted && (type === '0' || type === '\0')) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Resolve the npm CLI without a shell (same cascade as check-pack). */
export function resolveNpmInvocation() {
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && existsSync(execPath)) {
    return { file: process.execPath, args: [execPath], shell: false };
  }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) {
    return { file: process.execPath, args: [bundled], shell: false };
  }
  return { file: 'npm', args: [], shell: true };
}

const npmInvocation = resolveNpmInvocation();

/** The version announced by package.json and the corresponding git tag. */
export function version() {
  return pkg.version;
}

export function tag() {
  return `v${pkg.version}`;
}

/** The last tag reachable from HEAD, and how many commits separate them. */
export function lastTag() {
  const out = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
    cwd: root, encoding: 'utf8',
  }).trim() || null;
  let ahead = null;
  if (out) {
    try {
      ahead = Number(
        execFileSync('git', ['rev-list', '--count', `${out}..HEAD`], {
          cwd: root, encoding: 'utf8',
        }).trim(),
      );
    } catch { /* ahead stays null */ }
  }
  return { tag: out, ahead };
}

/** Read the CHANGELOG section for a version, accepting both `## [x.y.z]`
 *  (minor/major) and `### [x.y.z]` (patch) headers. Throws if missing or
 *  empty — a release with no notes must not be cut. */
export function changelogSection(ver) {
  const raw = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const lines = raw.split('\n');
  const startRe = new RegExp(`^#{2,3} \\[${ver}\\]`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for ${ver}`);
  }
  const end = lines.findIndex(
    (_, i) => i > start && (/^#{2,3} \[\d/.test(lines[i]) || /^#{2} \d/.test(lines[i])),
  );
  const section = lines.slice(start + 1, end === -1 ? lines.length : end).join('\n').trim();
  if (!section) {
    throw new Error(`CHANGELOG.md section for ${ver} is empty`);
  }
  return section;
}

/** Build the distributable tarball once, with its checksum and the stable
 *  alias. Returns the paths of every artifact. */
export function buildTarball({ dryRun = false } = {}) {
  const ver = version();
  const tmp = join(root, '.acceptance', 'release-artifacts');
  mkdirSync(tmp, { recursive: true });

  execFileSync(
    npmInvocation.file,
    [...npmInvocation.args, 'pack', '--pack-destination', tmp],
    { cwd: root, encoding: 'utf8', stdio: 'inherit' },
  );

  const tarball = join(tmp, `dominus-oss-${ver}.tgz`);
  const checksum = join(tmp, `dominus-oss-${ver}.tgz.sha256`);
  const alias = join(tmp, 'dominus-oss.tgz');
  const aliasChecksum = join(tmp, 'dominus-oss.tgz.sha256');

  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not produce ${tarball}`);
  }

  const tgzBytes = readFileSync(tarball);
  const hash = createHash('sha256').update(tgzBytes).digest('hex');
  writeFileSync(checksum, `${hash}  dominus-oss-${ver}.tgz\n`);
  writeFileSync(aliasChecksum, `${hash}  dominus-oss.tgz\n`);

  // The alias is the stable, versionless URL: a copy of the same bytes, never
  // a different build.
  writeFileSync(alias, tgzBytes);

  if (!dryRun) {
    // Sanity: the alias tarball must carry the announced version.
    const aliasBytes = readFileSync(alias);
    const aliasPkg = readFromTarball(aliasBytes, 'package/package.json');
    if (aliasPkg) {
      const aliasPkgJson = JSON.parse(Buffer.from(aliasPkg).toString('utf8'));
      if (aliasPkgJson.version !== ver) {
        throw new Error(
          `alias tarball carries ${aliasPkgJson.version}, expected ${ver}`,
        );
      }
    }
  }

  return { tarball, checksum, alias, aliasChecksum, version: ver, tag: tag() };
}

/** The six assets a release must carry, with their local paths. */
export function releaseAssets({ tarball, checksum, alias, aliasChecksum }) {
  const installShell = join(root, 'scripts', 'install.sh');
  const installPowerShell = join(root, 'scripts', 'install.ps1');
  return [
    { path: tarball, label: 'versioned tarball' },
    { path: checksum, label: 'versioned tarball checksum' },
    { path: alias, label: 'alias tarball (dominus-oss.tgz)' },
    { path: aliasChecksum, label: 'alias tarball checksum' },
    { path: installShell, label: 'Linux/macOS installer' },
    { path: installPowerShell, label: 'Windows installer' },
  ];
}

/** Working-tree cleanliness. */
export function workingTreeClean() {
  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  return { clean: out === '', output: out };
}

/** Is HEAD on `master`? */
export function onMaster() {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  return { onMaster: branch === 'master', branch };
}

/** Does the tag already exist locally / remotely? */
export function tagExists({ local = true, remote = true } = {}) {
  const t = tag();
  const results = {};
  if (local) {
    const out = execFileSync('git', ['tag', '--list', t], {
      cwd: root, encoding: 'utf8',
    }).trim();
    results.local = out.includes(t);
  }
  if (remote) {
    try {
      execFileSync('git', ['ls-remote', '--tags', 'origin', t], {
        cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      results.remote = true;
    } catch {
      results.remote = false;
    }
  }
  return { tag: t, ...results };
}
