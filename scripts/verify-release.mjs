#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Verifies that the PUBLISHED artifact is installable and functional.
 *
 * `check-pack` inspects the tarball this repository builds. This script
 * inspects the artifact a consumer actually receives: it installs the
 * package from the registry (or a local tarball) into a throwaway
 * directory and exercises it.
 *
 * Why this is a separate gate: the v1.2.0 release published nothing
 * (the npm trusted publisher was not configured, so the publish step
 * failed with E404) and the failure was discovered days later, by
 * reading the documentation. `check-pack` was green the whole time,
 * because the tarball in the build environment was fine — the
 * distribution was not. A gate that cannot see the published artifact
 * cannot protect the public release.
 *
 * What it proves:
 *   - the package installs on this platform (native bindings included);
 *   - the CLI entry point boots and reports the expected version;
 *   - `dominus health` opens a fresh database, applies the migrations
 *     and reports a healthy system — the first thing every user does;
 *   - the SPA is present in the artifact (a missing `dist/web/` turns
 *     every HTML route into a 404);
 *   - the manual-provider sample data is present (the zero-config
 *     path in the README depends on it);
 *   - the published tarball carries a provenance attestation, when the
 *     artifact comes from the registry.
 *
 * Usage:
 *   node scripts/verify-release.mjs                          # dominus-oss@<version> from the registry
 *   node scripts/verify-release.mjs --package dominus-oss@1.3.0
 *   node scripts/verify-release.mjs --tarball ./dominus-oss-1.3.0.tgz
 *   node scripts/verify-release.mjs --pack                    # pack the working tree and verify the tarball
 *   node scripts/verify-release.mjs --package ... --retries 20 --retry-delay 15000
 *
 * Exit code 0 when the artifact is usable, 1 when it is not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */
const args = process.argv.slice(2);

function argValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`verify-release: ${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function argNumber(flag, fallback) {
  const raw = argValue(flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`verify-release: ${flag} must be a non-negative number`);
    process.exit(2);
  }
  return parsed;
}

const tarballArg = argValue('--tarball');
const packageArg = argValue('--package');
const packMode = args.includes('--pack');
const expectedVersionArg = argValue('--expect-version');
const retries = argNumber('--retries', 6);
const retryDelayMs = argNumber('--retry-delay', 10000);

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const rootName = rootPkg.name;
const rootVersion = rootPkg.version;

// The escape hatch for an air-gapped machine, and only that: the
// verification installs the artifact from the registry, so it needs the
// network. It is deliberately loud, like the E2E smoke gate's.
if (process.env.SKIP_RELEASE_VERIFY === '1') {
  console.warn(
    'verify-release: SKIPPED by SKIP_RELEASE_VERIFY=1. The published artifact was ' +
      'not installed and run. This escape hatch exists for machines without a ' +
      'network; it is not a way to ship an unverified artifact.',
  );
  process.exit(0);
}

const expectedVersion = expectedVersionArg ?? (tarballArg || packMode ? undefined : rootVersion);

/* ------------------------------------------------------------------ *
 * npm invocation
 * ------------------------------------------------------------------ */
/**
 * Resolve how to invoke the npm CLI.
 *
 * Spawning `npm` through a shell triggers DEP0190 (arguments concatenated
 * unescaped), and resolving the CLI next to `process.execPath` fails on
 * GitHub-hosted runners, where npm lives outside the node prefix. The
 * cascade tries every reliable answer before resorting to the shell,
 * where the arguments are all literals owned by this file, so DEP0190
 * does not apply.
 */
function resolveNpmInvocation() {
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && existsSync(execPath)) {
    return { file: process.execPath, args: [execPath], shell: false };
  }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) {
    return { file: process.execPath, args: [bundled], shell: false };
  }
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(process.platform === 'win32' ? ';' : ':')) {
    if (dir.length === 0) continue;
    const candidate = join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (existsSync(candidate)) return { file: candidate, args: [], shell: false };
  }
  return { file: 'npm', args: [], shell: true };
}

const npmInvocation = resolveNpmInvocation();

function npm(argsToRun, { cwd, timeout = 300000 } = {}) {
  return execFileSync(npmInvocation.file, [...npmInvocation.args, ...argsToRun], {
    cwd: cwd ?? root,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    shell: npmInvocation.shell,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `readdirSync` that tolerates a missing directory. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * `npm pack --json` writes the JSON document to stdout, but npm may also
 * emit human-readable notices there. Parsing the whole stream then fails
 * with a SyntaxError, which would report a perfectly good tarball as
 * uninspectable. Extract the outermost JSON array/object instead by
 * bracket-matching from its first opening character.
 */
function extractJson(raw) {
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error('no JSON document in npm output');
  const open = raw[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON document in npm output');
}

/**
 * The CLI writes its structured logs and its configuration warnings to the
 * same stream as the command output, so `dominus health --json` does not
 * emit a bare JSON document. The verification therefore looks for the
 * first balanced JSON object in the stream instead of parsing the whole
 * of it — a warning line before the payload is not a failure.
 */
function extractJsonObject(raw) {
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(start, i + 1));
            if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
          } catch {
            // Not the payload — keep looking.
          }
          break;
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
const failures = [];
const notes = [];

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function fail(message) {
  failures.push(message);
  console.error(`[FAIL] ${message}`);
}

function note(message) {
  notes.push(message);
  console.log(`[INFO] ${message}`);
}

/* ------------------------------------------------------------------ *
 * The artifact under test
 * ------------------------------------------------------------------ */
let spec;
let localArtifact = false;

if (packMode) {
  // Pack the working tree and verify the tarball that would be
  // published. This is the pre-publish half of the gate: it proves the
  // artifact installs and boots BEFORE anything reaches the registry.
  const packDir = mkdtempSync(join(tmpdir(), 'dominus-pack-'));
  const raw = npm(['pack', '--pack-destination', packDir, '--json'], { cwd: root });
  let filename;
  try {
    const parsed = extractJson(raw);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    filename = entry?.filename;
  } catch {
    filename = undefined;
  }
  if (!filename) {
    console.error('verify-release: could not determine the packed tarball name');
    process.exit(1);
  }
  spec = join(packDir, filename);
  localArtifact = true;
  note(`packed ${filename} from the working tree`);
} else if (tarballArg) {
  spec = resolve(root, tarballArg);
  if (!existsSync(spec)) {
    console.error(`verify-release: tarball not found: ${spec}`);
    process.exit(1);
  }
  localArtifact = true;
} else {
  spec = packageArg ?? `${rootName}@${rootVersion}`;
}

/**
 * The registry is eventually consistent: a package published a minute
 * ago may not be visible yet. The retry loop is the difference between
 * "the publish failed" and "the publish is not visible yet".
 */
async function installArtifact(installDir) {
  let lastError = '';
  for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
    try {
      npm(
        [
          'install',
          '--no-save',
          '--no-audit',
          '--no-fund',
          '--prefix',
          installDir,
          spec,
        ],
        { cwd: installDir, timeout: 600000 },
      );
      return true;
    } catch (err) {
      const stderr = err?.stderr ? String(err.stderr) : '';
      const stdout = err?.stdout ? String(err.stdout) : '';
      lastError = (stderr || stdout || err?.message || String(err)).trim();
      if (attempt < retries) {
        note(
          `install attempt ${attempt}/${retries} failed (${lastError.split('\n')[0]}) — retrying in ${
            retryDelayMs / 1000
          }s`,
        );
        await sleep(retryDelayMs);
      }
    }
  }
  console.error(`verify-release: could not install ${spec}`);
  console.error(lastError);
  return false;
}

function packageDirOf(installDir, name) {
  // A scoped package installs to node_modules/@scope/name.
  return join(installDir, 'node_modules', ...name.split('/'));
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */
const installDir = mkdtempSync(join(tmpdir(), 'dominus-verify-'));

// The installed identity is discovered from the artifact itself: the
// verified package may be published under a different name than the
// repository (a scoped package, a tarball built elsewhere).
let installedName = rootName;
let installedVersion = expectedVersion ?? rootVersion;

try {
  const installed = await installArtifact(installDir);
  if (!installed) {
    process.exitCode = 1;
  } else {
    // The installed name may differ from the repository name when a
    // tarball is verified; read it from the artifact itself.
    const nodeModules = join(installDir, 'node_modules');
    if (!existsSync(join(packageDirOf(installDir, rootName), 'package.json'))) {
      const entries = existsSync(nodeModules) ? readdirSafe(nodeModules) : [];
      const candidate = entries.find((e) => e.startsWith('@'));
      const scoped = candidate ? readdirSafe(join(nodeModules, candidate)) : [];
      const plain = entries.find((e) => !e.startsWith('@') && !e.startsWith('.'));
      const pick = plain ?? scoped[0];
      if (pick) installedName = candidate ? `${candidate}/${pick}` : pick;
    }
    const pkgDir = packageDirOf(installDir, installedName);

    if (!existsSync(join(pkgDir, 'package.json'))) {
      fail(`the installed artifact has no package.json at ${pkgDir}`);
    } else {
      const installedPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
      installedName = installedPkg.name ?? installedName;
      installedVersion = installedPkg.version ?? installedVersion;
      pass(`installed ${installedPkg.name}@${installedPkg.version}`);

      if (expectedVersion && installedPkg.version !== expectedVersion) {
        fail(`installed version ${installedPkg.version} does not match the expected ${expectedVersion}`);
      } else {
        pass(`the installed version matches the expected ${installedPkg.version}`);
      }

      // The artifact must contain the files a consumer needs. A missing
      // SPA turns every HTML route into a 404; missing sample data
      // breaks the zero-config path the README advertises.
      for (const required of [
        'dist/cli.js',
        'dist/index.js',
        'dist/web/index.html',
        'examples/closeout-sample.csv',
        'examples/keywords-sample.json',
        'examples/comps-sample.csv',
      ]) {
        const target = join(pkgDir, ...required.split('/'));
        if (!existsSync(target)) {
          fail(`the installed artifact is missing ${required}`);
        } else {
          pass(`${required} is present`);
        }
      }

      if (existsSync(join(pkgDir, 'dist', 'web'))) {
        const assets = join(pkgDir, 'dist', 'web', 'assets');
        if (!existsSync(assets) || !statSync(assets).isDirectory()) {
          fail('the installed artifact has no dist/web/assets directory');
        } else {
          pass('the SPA assets are present');
        }
      }

      // The CLI must boot and report the version it claims.
      const cliPath = join(pkgDir, 'dist', 'cli.js');
      if (existsSync(cliPath)) {
        // The logs are silenced and the sample data is pointed at the
        // installed package: the check is about the artifact, and a
        // verification that depends on the network or on the current
        // working directory is a flaky verification.
        const childEnv = {
          ...process.env,
          LOG_LEVEL: 'silent',
          KEYWORD_DATA_PATH: join(pkgDir, 'examples', 'keywords-sample.json'),
          COMPS_DATA_PATH: join(pkgDir, 'examples', 'comps-sample.csv'),
        };
        try {
          const versionOutput = execFileSync(process.execPath, [cliPath, '--version'], {
            encoding: 'utf-8',
            timeout: 60000,
            env: childEnv,
          });
          const reported = versionOutput.trim();
          if (reported.includes(installedPkg.version)) {
            pass(`the CLI reports version ${reported}`);
          } else {
            fail(`the CLI reports "${reported}", which does not contain ${installedPkg.version}`);
          }
        } catch (err) {
          fail(`the CLI failed to run --version: ${err?.message ?? String(err)}`);
        }

        // `dominus health` is the first command a user runs: it opens a
        // fresh database, applies the migrations and reports the system
        // state. It is the end-to-end proof that the artifact works.
        const healthDb = join(installDir, 'data', 'verify.db');
        try {
          const healthOutput = execFileSync(process.execPath, [cliPath, 'health', '--json'], {
            encoding: 'utf-8',
            timeout: 120000,
            cwd: installDir,
            env: {
              ...childEnv,
              DATABASE_PATH: healthDb,
              API_KEYS: 'verify=sk-verify-release-check',
            },
          });
          const parsed = extractJsonObject(healthOutput);
          if (parsed === null) {
            fail('`dominus health` produced no JSON report');
          } else {
            if (parsed.status === 'ok') {
              pass('`dominus health` reports a healthy system on a fresh database');
            } else {
              fail(`\`dominus health\` reported "${parsed.status}"`);
            }
            if (parsed.version === installedPkg.version) {
              pass('`dominus health` reports the installed version');
            } else {
              fail(
                `\`dominus health\` reports version ${parsed.version}, expected ${installedPkg.version}`,
              );
            }
          }
        } catch (err) {
          const stderr = err?.stderr ? String(err.stderr) : '';
          fail(`\`dominus health\` failed: ${(stderr || err?.message || String(err)).trim()}`);
        }
      }
    }

    // Provenance: the published tarball must carry the attestation that
    // links it to this repository, this workflow and this commit.
    if (!localArtifact) {
      try {
        const view = npm(['view', `${installedName}@${installedVersion}`, 'dist.attestations', '--json']);
        const raw = view.trim();
        const parsed = raw === '' ? null : JSON.parse(raw);
        const count = Array.isArray(parsed) ? parsed.length : parsed ? 1 : 0;
        if (count > 0) {
          pass(`the published artifact carries ${count} provenance attestation(s)`);
        } else {
          fail('the published artifact carries no provenance attestation');
        }
      } catch (err) {
        fail(`could not read the provenance attestation: ${err?.message ?? String(err)}`);
      }
    } else {
      note('provenance is not checked for a local tarball — it is published by the release workflow');
    }
  }
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nverify-release: FAILED (${failures.length} problem(s)) — the artifact is not releasable.`);
  process.exit(1);
}

console.log('\nverify-release: OK — the artifact installs, boots and reports the expected version.');
