#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The release doctor.
//
// The v1.3.1 release commit sat on master for days with no tag, no image
// and no package, while the repository - the README, the Terraform
// example, the CHANGELOG - announced the version. Every gate was green:
// the gates check the repository against itself, and the repository was
// internally consistent. The artifact was missing.
//
// This command checks the repository against the WORLD:
//
//   1. the working tree is clean (nothing uncommitted goes into a release);
//   2. the version in package.json has a tag (the release is cut);
//   3. the tag is on the remote (the release is reachable);
//   4. the repository is internally consistent (the existing gate);
//   5. with --remote: the package is on npm, the image is in the
//      registry, and the public release alias (tarball + checksum) exists
//      and carries the announced version.
//
// Usage:
//   node scripts/release-doctor.mjs           # offline checks
//   node scripts/release-doctor.mjs --remote  # also the registries
//
// Exit 0 = the release state is real, 1 = something is announced but not
// published.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const remote = process.argv.includes('--remote');

const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
}

function sh(args, options = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(args[0], args.slice(1), {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
      }).trim(),
    };
  } catch (err) {
    return {
      ok: false,
      output: err.stdout ? err.stdout.toString().trim() : '',
      error: err.stderr ? err.stderr.toString().trim() : String(err),
    };
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

// ── 1. the working tree ──────────────────────────────────────────────
const status = sh(['git', 'status', '--porcelain']);
if (!status.ok) {
  record('warn', 'working tree', `git status failed: ${status.error}`);
} else if (status.output === '') {
  record('pass', 'working tree', 'clean - nothing uncommitted');
} else {
  record(
    'fail',
    'working tree',
    `${status.output.split('\n').length} uncommitted change(s) - a release is made from a clean tree`,
  );
}

// ── 2. the tag ───────────────────────────────────────────────────────
const localTag = sh(['git', 'tag', '--list', tag]);
const hasLocalTag = localTag.ok && localTag.output.includes(tag);

const describe = sh(['git', 'describe', '--tags', '--abbrev=0']);
const lastTag = describe.ok ? describe.output : '';
if (!lastTag) {
  record('warn', 'last tag', 'no tag found in the history');
} else {
  const ahead = sh(['git', 'rev-list', '--count', `${lastTag}..HEAD`]);
  const count = ahead.ok ? ahead.output : '?';
  if (count === '0') {
    record('pass', 'commits since the last tag', `none (HEAD is ${lastTag})`);
  } else {
    record('warn', 'commits since the last tag', `${count} commit(s) after ${lastTag}`);
  }
}

if (hasLocalTag) {
  record('pass', 'version tag', `${tag} exists`);
  const points = sh(['git', 'rev-list', '-n', '1', tag]);
  const head = sh(['git', 'rev-parse', 'HEAD']);
  if (points.ok && head.ok && points.output === head.output) {
    record('pass', 'tag position', `${tag} points at HEAD`);
  } else {
    record('fail', 'tag position', `${tag} does not point at HEAD - the release would ship other code`);
  }
} else {
  record(
    'fail',
    'version tag',
    `no tag ${tag} - package.json announces ${version} but the release is not cut`,
  );
}

// ── 3. the tag on the remote ─────────────────────────────────────────
if (remote) {
  const lsRemote = sh(['git', 'ls-remote', '--tags', 'origin', tag]);
  if (!lsRemote.ok) {
    record('warn', 'remote tag', `could not reach the remote: ${lsRemote.error}`);
  } else if (lsRemote.output.includes(`refs/tags/${tag}`)) {
    record('pass', 'remote tag', `${tag} is on origin`);
  } else {
    record('fail', 'remote tag', `${tag} is not on origin - the release is not reachable`);
  }
}

// ── 4. the repository consistency (the existing gate) ────────────────
const consistency = sh([process.execPath, 'scripts/check-release-consistency.mjs']);
if (consistency.ok) {
  record('pass', 'repository consistency', 'the repository agrees with package.json');
} else {
  record('fail', 'repository consistency', consistency.error || consistency.output || 'drift found');
}

// ── 5. the registries ────────────────────────────────────────────────
if (remote) {
  const npmView = sh(['npm', 'view', `dominus-oss@${version}`, 'version']);
  if (!npmView.ok) {
    record(
      'warn',
      'npm package',
      `dominus-oss@${version} is not on the registry - "npx dominus-oss" does not work yet`,
    );
  } else {
    record('pass', 'npm package', `dominus-oss@${npmView.output}`);
  }

  // ── 5a. the public release channel: alias tarball + checksum ─────────
  // The alias (`dominus-oss.tgz`) is the channel an installer and a reader
  // rely on: it must exist, its checksum must match, and the tarball must
  // carry the announced version.
  const aliasUrl = `https://github.com/AlessioBrillo/dominus/releases/latest/download/dominus-oss.tgz`;
  const aliasChecksumUrl = `${aliasUrl}.sha256`;

  try {
    const aliasRes = await fetch(aliasUrl);
    if (!aliasRes.ok) {
      record('warn', 'release alias tarball', `could not download ${aliasUrl}: HTTP ${aliasRes.status}`);
    } else {
      const aliasBytes = Buffer.from(await aliasRes.arrayBuffer());
      const actualChecksum = createHash('sha256').update(aliasBytes).digest('hex');

      const checksumRes = await fetch(aliasChecksumUrl);
      if (!checksumRes.ok) {
        record('fail', 'release alias checksum', `could not download ${aliasChecksumUrl}: HTTP ${checksumRes.status}`);
      } else {
        const checksumText = await checksumRes.text();
        const expectedMatch = /^[0-9a-fA-F]{64}/.exec(checksumText.trim());
        const expectedChecksum = expectedMatch ? expectedMatch[0].toLowerCase() : null;

        if (expectedChecksum === null) {
          record('fail', 'release alias checksum', `could not parse a checksum from ${aliasChecksumUrl}`);
        } else if (actualChecksum !== expectedChecksum) {
          record(
            'fail',
            'release alias checksum',
            `alias tarball sha256 is ${actualChecksum}, the release publishes ${expectedChecksum}`,
          );
        } else {
          record('pass', 'release alias checksum', 'alias tarball checksum verified');
        }
      }

      // The tarball must carry the announced version: extract package/package.json.
      try {
        const { extract } = await import('node:tar');
        let pkgJson = null;
        await extract(aliasBytes, {
          onentry: (entry) => {
            if (entry.file === 'package/package.json') {
              const chunks = [];
              entry.on('data', (chunk) => chunks.push(chunk));
              entry.on('end', () => {
                try {
                  pkgJson = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                  // ignore parse errors
                }
              });
            }
          },
        });
        if (pkgJson === null) {
          record('fail', 'release alias contents', 'alias tarball has no package/package.json');
        } else if (pkgJson.version === version) {
          record('pass', 'release alias contents', `alias tarball carries ${pkgJson.name}@${pkgJson.version}`);
        } else {
          record('fail', 'release alias contents', `alias tarball carries ${pkgJson.name}@${pkgJson.version}, expected ${version}`);
        }
      } catch (err) {
        record('warn', 'release alias contents', `could not inspect tarball contents: ${err.message}`);
      }
    }
  } catch (err) {
    record('warn', 'release alias tarball', `could not reach ${aliasUrl}: ${err.message}`);
  }

  const packages = sh([
    'gh',
    'api',
    '/users/AlessioBrillo/packages/container/dominus/versions?per_page=100',
    '--jq',
    '.[].metadata.container.tags[]',
  ]);
  if (!packages.ok) {
    record(
      'warn',
      'container image',
      'the image could not be verified (the GitHub token needs the read:packages scope)',
    );
  } else if (packages.output.includes(tag)) {
    record('pass', 'container image', `${tag} is in the registry`);
  } else {
    record('fail', 'container image', `${tag} is not in the registry - the deployment would pull nothing`);
  }
} else {
  record('info', 'registries', 'not checked - pass --remote to check npm and the image registry');
}

// ── Report ───────────────────────────────────────────────────────────
const order = { fail: 0, warn: 1, pass: 2, info: 3 };
results.sort((a, b) => order[a.status] - order[b.status]);

const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
for (const result of results) {
  console.log(`[${icon[result.status]}] ${result.name}: ${result.detail}`);
}

const failures = results.filter((r) => r.status === 'fail');
console.log(
  `\nrelease-doctor: ${results.length} check(s), ${failures.length} failed` +
    (remote ? '' : ' (offline checks only - add --remote to check the registries)'),
);

if (failures.length > 0) {
  console.error(
    '\nThe release is announced but not published. The failed checks above are the blockers.',
  );
  process.exit(1);
}

console.log('\nThe release state is real.');
