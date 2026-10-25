#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trademark gate canary.
 *
 * Verifies the trademark gate answers against the live public registers.
 * This runs against the real network (unlike `npm run gate`, which is
 * offline), so it is deliberately NOT part of `npm run gate`. It is run by
 * the release workflow and by operators before a tag to detect endpoint
 * drift before it reaches a release.
 *
 * The assertions encode the fail-closed contract:
 *   - a mark that IS registered → blocked (never clear)
 *   - a mark that is NOT registered → clear (never blocked)
 *
 * Usage:
 *   npm run build                 # first, so dist/cli.js exists
 *   npm run check:trademarks      # then verify the gate answers live
 *
 * Exit 0 = the gate answers correctly live, 1 = drift or outage.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const cli = join(root, 'dist', 'cli.js');

const MAX_ATTEMPTS = 2;

// [domain, expected verdict, why]
const CASES = [
  [
    'nike.com',
    'blocked',
    'NIKE is a registered US trademark (status 800, reg. 0978952) — the gate must block it.',
  ],
  [
    'vintagecoffee.com',
    'clear',
    'no matching record in either register — the gate must clear it.',
  ],
];

const failures = [];
let attempts = 0;

function fail(message) {
  failures.push(message);
  console.error(`[FAIL] ${message}`);
}

function ok(message) {
  console.log(`[ok] ${message}`);
}

function scoreDomain(domain) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts += 1;
    try {
      const stdout = execFileSync(process.execPath, [cli, 'score', domain, '--json'], {
        cwd: root,
        env: {
          ...process.env,
          // Deterministic scoring data so the commercial signals match the
          // README's worked example (and the verdict is reproducible).
          KEYWORD_DATA_PATH: join(root, 'examples', 'keywords-sample.json'),
          COMPS_DATA_PATH: join(root, 'examples', 'comps-sample.csv'),
          LOG_PRETTY: 'false',
        },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return JSON.parse(stdout);
    } catch (err) {
      lastError = err;
      const stdout = err.stdout ? err.stdout.toString() : '';
      const stderr = err.stderr ? err.stderr.toString() : '';
      console.log(
        `[retry] attempt ${attempt}/${MAX_ATTEMPTS} for ${domain} failed: ${String(err)}\n` +
          `  stdout: ${stdout.slice(0, 200)}\n  stderr: ${stderr.slice(0, 200)}`,
      );
    }
  }
  throw lastError;
}

if (!existsSync(cli)) {
  console.error(
    '[FAIL] dist/cli.js is missing — run `npm run build` before `npm run check:trademarks`.',
  );
  process.exit(1);
}

for (const [domain, expectedVerdict, why] of CASES) {
  let result;
  try {
    result = scoreDomain(domain);
  } catch (err) {
    fail(`${domain}: could not get a verdict from the live gate (${String(err)})`);
    continue;
  }

  const verdict = result?.trademark?.verdict;
  const sources = result?.trademark?.sources ?? [];
  const recommended = result?.recommended ?? false;

  if (verdict === expectedVerdict) {
    ok(
      `${domain}: trademark ${verdict} (sources: ${sources.join(', ') || 'none'}, recommended: ${recommended}) — ${why}`,
    );
  } else {
    fail(
      `${domain}: expected trademark ${expectedVerdict}, got ${verdict} (sources: ${sources.join(
        ', ',
      ) || 'none'}) — ${why}`,
    );
  }

  // A verified clear on a non-strict TLD with EUIPO unconfigured must not be
  // marked partial (D7: "not configured" is not "failed").
  if (domain === 'vintagecoffee.com' && result?.trademark?.partial === true) {
    fail(`${domain}: clear verdict should not be partial when EUIPO is simply unconfigured`);
  }
}

// ── Report ───────────────────────────────────────────────────────────

console.log(`\ncheck-trademarks: ${CASES.length} case(s), ${attempts} attempt(s)`);

if (failures.length > 0) {
  console.error(`FAIL - ${failures.length} problem(s)`);
  process.exit(1);
}

console.log('OK - the trademark gate answers correctly against the live registers.');
