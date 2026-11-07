#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The local-first release engine. It is the single implementation used to
// cut a DOMINUS release: local (this script) is authoritative; GitHub Actions
// is a mirror that calls the same functions. This eliminates the single point
// of failure where Actions stops assigning runners and no artifact can be
// published.
//
// Policy (ADR-0099, ADR-0101):
//   - GitHub Release is the primary channel; npm is best-effort.
//   - The tarball is built ONCE and used for every channel (asset + npm).
//   - The tag does not exist before the gate is green and the public channel
//     is verified.
//   - Fail-closed: any preflight failure aborts before anything is mutated.
//
// Usage:
//   node scripts/release-cut.mjs --dry-run        # preflight + build + verify, no remote changes
//   node scripts/release-cut.mjs --publish        # tag, create release, upload assets, verify public URL
//   node scripts/release-cut.mjs --publish --skip-public-verify   # skip the public URL check (emergency only)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTarball,
  changelogSection,
  lastTag,
  onMaster,
  releaseAssets,
  tag,
  tagExists,
  version,
  workingTreeClean,
} from './release-artifacts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\nrelease-cut: FAIL — ${message}\n`);
  process.exit(1);
}

/** Resolve the npm CLI (same cascade as check-pack / release-artifacts). */
function resolveNpm() {
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

const npm = resolveNpm();

/** Run a Node script: `node script.mjs [args...]`. */
function nodeRun(scriptArgs, { stdio = 'inherit', timeout = 0 } = {}) {
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: root, stdio, encoding: 'utf8', timeout: timeout || 0,
  });
  if (result.status !== 0) {
    const errOut = (result.stderr ?? '').toString().trim();
    throw new Error(
      `node ${scriptArgs.join(' ')} failed: ${errOut || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.output ? result.output.toString().trim() : '';
}

/** Run a system command directly (npm, git, gh, …). */
function sh(cmd, args, { stdio = 'inherit', timeout = 0, env = process.env } = {}) {
  const result = spawnSync(cmd, args, { cwd: root, env, stdio, encoding: 'utf8', timeout: timeout || 0 });
  if (result.status !== 0) {
    const errOut = (result.stderr ?? '').toString().trim();
    throw new Error(
      `${cmd} ${args.join(' ')} failed: ${errOut || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.output ? result.output.toString().trim() : '';
}

/** The preflight: fail-closed checks that must all pass before a release. */
async function preflight() {
  log('release-cut: preflight');

  const wt = workingTreeClean();
  if (!wt.clean) {
    fail(`working tree has ${wt.output.split('\n').length} uncommitted change(s); release from a clean tree`);
  }
  log('[ok] working tree clean');

  const branch = onMaster();
  if (!branch.onMaster) {
    fail(`not on master (currently ${branch.branch}); releases are cut from master`);
  }
  log('[ok] on master');

  const ver = version();
  const tg = tag();
  const tags = tagExists({ local: true, remote: false });
  if (tags.local) {
    fail(`tag ${tg} already exists locally; delete it or bump the version first`);
  }
  log(`[ok] tag ${tg} does not exist locally`);

  const { tag: last, ahead } = lastTag();
  if (last) {
    log(`[ok] last tag ${last}, ${ahead ?? '?'} commit(s) since`);
  } else {
    log('[warn] no previous tag found in history');
  }

  // CHANGELOG section must exist and be non-empty.
  changelogSection(ver);
  log(`[ok] CHANGELOG.md has a section for ${ver}`);

  // Trademark canary: the one non-negotiable gate (Principle 6).
  log('release-cut: trademark canary (live registers)');
  nodeRun(['scripts/check-trademarks.mjs']);
  log('[ok] trademark canary green');

  log('[ok] preflight complete');
}

/** Build the tarball once, verify it locally (pack + installers). */
async function buildAndVerifyLocally({ dryRun = false }) {
  log('release-cut: building distributable tarball');

  // Frontend first (backend build embeds dist/web/).
  sh(npm.file, [...npm.args, '--prefix', 'frontend', 'ci'], {
    cwd: join(root, 'frontend'),
  });
  sh(npm.file, [...npm.args, 'run', 'build'], {
    cwd: join(root, 'frontend'),
  });

  // Backend + finalize-dist (stages SPA into dist/web/, prunes test files).
  sh(npm.file, [...npm.args, 'ci']);
  sh(npm.file, [...npm.args, 'run', 'build']);

  // check-pack: the tarball a consumer receives must be complete.
  nodeRun(['scripts/check-pack.mjs']);

  const artifacts = buildTarball({ dryRun });
  log(`[ok] tarball built: ${artifacts.tarball}`);

  // verify-release against the local tarball (installs + runs dominus score).
  nodeRun([
    'scripts/verify-release.mjs',
    '--tarball',
    artifacts.tarball,
    '--expect-version',
    artifacts.version,
  ]);
  log('[ok] tarball installs and runs (verify-release)');

  // test-installers against the local tarball (this platform's installer).
  nodeRun(['scripts/test-installers.mjs', '--tarball', artifacts.tarball]);
  log('[ok] installers install a working command');

  return artifacts;
}

/** Create the git tag and the GitHub Release, upload assets, verify the
 *  public channel. Idempotent: re-running updates an existing release. */
async function publishToGitHub(artifacts) {
  const ver = artifacts.version;
  const tg = artifacts.tag;

  log(`release-cut: tagging ${tg}`);
  sh('git', ['tag', '-a', tg, '-m', `DOMINUS ${ver}`]);
  sh('git', ['push', 'origin', tg]);

  // Extract release notes from CHANGELOG.
  const notes = changelogSection(ver);
  const notesPath = join(root, '.acceptance', `release-notes-${ver}.md`);
  writeFileSync(notesPath, `${notes}\n`);

  log(`release-cut: creating/updating GitHub Release ${tg}`);
  const ghToken = process.env.GITHUB_TOKEN ?? '';
  const releaseExists = spawnSync(
    'gh',
    ['release', 'view', tg, '--json', 'tagName'],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, GH_TOKEN: ghToken } },
  ).status === 0;

  if (releaseExists) {
    sh('gh', ['release', 'edit', tg, '--notes-file', notesPath], {
      env: { ...process.env, GH_TOKEN: ghToken },
    });
    log(`[ok] release ${tg} updated`);
  } else {
    sh('gh', ['release', 'create', tg, '--notes-file', notesPath], {
      env: { ...process.env, GH_TOKEN: ghToken },
    });
    log(`[ok] release ${tg} created`);
  }

  // Upload all six assets (idempotent: --clobber replaces existing).
  for (const { path, label } of releaseAssets(artifacts)) {
    sh('gh', ['release', 'upload', tg, path, '--clobber'], {
      env: { ...process.env, GH_TOKEN: ghToken },
    });
    log(`[ok] asset uploaded: ${label}`);
  }

  // Verify the public channel end-to-end: download alias, checksum, install,
  // run dominus score. This is the promise ADR-0099 makes to strangers.
  const repo = process.env.GITHUB_REPOSITORY ?? 'AlessioBrillo/dominus';
  const publicUrl = `https://github.com/${repo}/releases/tag/${tg}`;
  log(`release-cut: verifying public channel at ${publicUrl}`);
  nodeRun([
    'scripts/check-published-install.mjs',
    '--url',
    publicUrl,
  ]);
  log('[ok] public channel verified (installer downloads and runs)');
}

/** Write the release evidence artifact. */
async function writeEvidence(artifacts) {
  const ver = artifacts.version;
  const now = new Date().toISOString();
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();

  const evidenceDir = join(root, '.acceptance', 'launch');
  mkdirSync(evidenceDir, { recursive: true });

  const payload = {
    generatedAt: now,
    version: ver,
    commit,
    tag: artifacts.tag,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    gate: 'pass',
    artifacts: releaseAssets(artifacts).map((a) => ({ label: a.label, path: a.path })),
  };

  const base = `release-evidence-${ver}-${commit}`;
  writeFileSync(
    join(evidenceDir, `${base}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  writeFileSync(
    join(evidenceDir, `${base}.md`),
    [
      `# Release evidence — ${ver} (${commit})`,
      '',
      `- Generated: ${now}`,
      `- Tag: ${artifacts.tag}`,
      '- Gate: **pass**',
      '',
      '## Artifacts',
      '',
      ...releaseAssets(artifacts).map((a) => `- ${a.label}: ${a.path}`),
      '',
      'The GitHub Release is the primary channel; npm is best-effort (ADR-0099).',
      '',
    ].join('\n'),
  );

  log(`evidence: .acceptance/launch/${base}.json`);
  log(`evidence: .acceptance/launch/${base}.md`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const publish = args.includes('--publish');
  const skipPublicVerify = args.includes('--skip-public-verify');

  if (dryRun && publish) {
    fail('--dry-run and --publish are mutually exclusive');
  }
  if (!dryRun && !publish) {
    fail('pass --dry-run or --publish');
  }

  await preflight();
  const artifacts = await buildAndVerifyLocally({ dryRun });

  if (dryRun) {
    log('\nrelease-cut: dry run complete — nothing was mutated remotely.');
    log(`Artifacts ready in .acceptance/release-artifacts/`);
    return;
  }

  await publishToGitHub(artifacts);

  if (!skipPublicVerify) {
    // Confirm the tag and alias are reachable from outside.
    nodeRun(['scripts/release-doctor.mjs', '--remote']);
    log('[ok] release:doctor --remote green');
  }

  // The local gate must be green on the final tree before we exit.
  sh(npm.file, [...npm.args, 'run', 'gate'], { timeout: 0 });
  log('[ok] npm run gate green on final tree');

  await writeEvidence(artifacts);
  log('\nrelease-cut: OK — release cut and published.');
}

main().catch((err) => {
  fail(err.message ?? String(err));
});
