#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Version and record consistency gate.
 *
 * check:doc-drift compares the architecture counts against the source tree.
 * It does not notice that the launch readiness document still describes the
 * version from three releases ago, that the roadmap still calls the current
 * tag "unreleased", or that the ADR index says 102 when 111 records exist.
 * Those are the lines a reader uses to decide whether the project is real.
 *
 * Every check below derives its truth from package.json, CHANGELOG.md or the
 * filesystem, so a release updates the checks instead of breaking them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (file) => readFileSync(join(root, file), 'utf8');

const failures = [];
let checksRun = 0;

function check(description, condition, detail = '') {
  checksRun++;
  if (!condition) failures.push(`${description}${detail ? ` — ${detail}` : ''}`);
}

const version = JSON.parse(read('package.json')).version;
const tag = `v${version}`;

// 1. The changelog must announce the version the package declares.
const changelog = read('CHANGELOG.md');
check(
  'CHANGELOG announces the package version',
  new RegExp(`^###\\s*\\[?${version.replaceAll('.', '\\.')}\\]?`, 'm').test(changelog),
  `package.json says ${tag}, CHANGELOG has no ${version} section`,
);

// 2. Documents that state the current release state must not name an older
//    version as "checked against" or "released". Historical references in
//    the CHANGELOG and ADRs are allowed: they are records of the past.
const currentVersionClaims = [
  ['CLAUDE.md', /^DOMINUS\s+v(\d+\.\d+\.\d+)/m],
  ['docs/releases/cloud-launch-readiness.md', /\bat\s+v?(\d+\.\d+\.\d+)\s*\(/m],
];
for (const [file, pattern] of currentVersionClaims) {
  if (!existsSync(join(root, file))) continue;
  const found = read(file).match(pattern)?.[1] ?? '';
  check(
    `${file} states the current version`,
    found === version,
    `found ${found || 'none'} (current is ${version})`,
  );
}

// 3. The roadmap must not call the current tag unreleased.
const roadmap = read('ROADMAP.md');
const roadmapLine = roadmap.split('\n').find((line) => line.startsWith(`v${version} `));
check(
  'ROADMAP does not call the current tag unreleased',
  roadmapLine !== undefined && !/unreleased/i.test(roadmapLine),
  roadmapLine === undefined ? `no v${version} entry` : roadmapLine.trim(),
);

// 4. The ADR index count must match the records on disk.
const indexBody = read('docs/adr/README.md');
const claimed = indexBody.split('\n').filter((line) => /^\|\s*\[\d{4}\]/.test(line)).length;
const adrFiles = readdirSync(join(root, 'docs/adr')).filter((f) => /^\d{4}-.+\.md$/.test(f)).length;
check(
  'ADR index count matches the records',
  claimed === adrFiles,
  `index lists ${claimed}, disk has ${adrFiles}`,
);

// 5. The public pricing comment must point at the ADR that decided it.
const landing = read('frontend/src/pages/LandingPage.tsx');
check(
  'Landing pricing comment cites ADR-0111',
  /ADR-0111/.test(landing) && !/Keep in sync with ADR-0026/.test(landing),
  'ADR-0026 was superseded by ADR-0111',
);

// 6. The npm channel must not be described as a published channel.
const releaseWorkflow = read('.github/workflows/release.yml');
check(
  'Release workflow does not publish to npm',
  !/^\s*run:\s*npm publish/m.test(releaseWorkflow),
  'ADR-0102 makes GitHub Release the sole channel',
);

if (failures.length > 0) {
  process.stderr.write(`\ncheck-version-consistency: FAIL (${failures.length})\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`check-version-consistency: OK (${checksRun} checks, ${tag})\n`);
