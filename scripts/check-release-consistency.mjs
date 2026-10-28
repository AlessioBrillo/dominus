#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Release consistency gate: the version a user reads must be the version
// that gets deployed.
//
// The v1.3.0 release shipped a repository whose README announced a version
// (v1.2.0), a Terraform example that booted the v1.2.0 image and a docker
// smoke that pulled v1.2.0 — three places that had to be bumped by hand at
// release time and had all been forgotten. Nothing failed: the tag was
// valid, the CI was green, and the artifacts were simply from the wrong
// release. Documentation rot that only a human can notice is not a gate.
//
// This check derives the truth from package.json and fails when the
// repository disagrees with it:
//
//   1. the README version badge equals package.json
//   2. the README "Project Status" paragraph names the current version
//   3. the Terraform example pins the current image tag
//   4. the Terraform image_tag variable has NO default (a default is a
//      silent "deploy whatever was current when this was written")
//   5. the docker smoke does not hardcode a version tag
//   6. the newest CHANGELOG section is the current version
//
// Usage:
//   node scripts/check-release-consistency.mjs
//   exit 0 = green, exit 1 = drift found

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const findings = [];

function read(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch (err) {
    findings.push(`${rel}: cannot be read (${err.message})`);
    return null;
  }
}

const pkgRaw = read('package.json');
if (!pkgRaw) {
  report();
}
const pkg = JSON.parse(pkgRaw);
const version = pkg.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  findings.push(`package.json: version "${version}" is not a plain semver version`);
}

// ── 1 + 2: the README ───────────────────────────────────────────────
const readme = read('README.md');
if (readme) {
  const badge = /badge\/version-([0-9A-Za-z.\-]+)-/.exec(readme);
  if (badge && badge[1] !== version) {
    findings.push(
      `README.md: the version badge says ${badge[1]}, package.json says ${version}`,
    );
  }
  // The Project Status paragraph is the first thing a reader sees after the
  // quickstart: it must name the release the repository is at. The pattern
  // is a constant one and the version is compared, not interpolated into a
  // regular expression: a regex built from a value is a sanitization
  // surface, and a comparison on the captured version is both simpler
  // and exact.
  const status = /DOMINUS v(\d+\.\d+\.\d+)/.exec(readme);
  if (!status || status[1] !== version) {
    findings.push(
      `README.md: the Project Status paragraph does not mention "DOMINUS v${version}"`,
    );
  }
}

// ── 3 + 4: the Terraform operator example ───────────────────────────
const tfvars = read('deploy/terraform/terraform.tfvars.example');
if (tfvars) {
  const m = /^\s*image_tag\s*=\s*"([^"]+)"/m.exec(tfvars);
  if (!m) {
    findings.push('deploy/terraform/terraform.tfvars.example: no image_tag assignment found');
  } else if (m[1] !== `v${version}`) {
    findings.push(
      `deploy/terraform/terraform.tfvars.example: image_tag is "${m[1]}", expected "v${version}"`,
    );
  }
}

const mainTf = read('deploy/terraform/main.tf');
if (mainTf) {
  const varBlock = /variable\s+"image_tag"\s*\{([\s\S]*?)\n\}/.exec(mainTf);
  if (!varBlock) {
    findings.push('deploy/terraform/main.tf: the image_tag variable is missing');
  } else if (/^\s*default\s*=/m.test(varBlock[1])) {
    findings.push(
      'deploy/terraform/main.tf: image_tag has a default. A default is a stale image waiting to be ' +
        'applied — the operator must name the release tag explicitly.',
    );
  }
}

// ── 5: the docker smoke must not pin a version by hand ─────────────
const smoke = read('scripts/docker-smoke.mjs');
if (smoke) {
  const literal = /['"]v\d+\.\d+\.\d+['"]/.exec(smoke);
  if (literal) {
    findings.push(
      `scripts/docker-smoke.mjs: hardcodes the image tag ${literal[0]}. Derive it from package.json ` +
        'or require it in the environment, so a release bump cannot leave the smoke on an old image.',
    );
  }
}

// ── 6: the CHANGELOG must know the current version ─────────────────
const changelog = read('CHANGELOG.md');
if (changelog) {
  // standard-version writes `##` for a minor/major bump and `###` for a
  // patch, so accepting only `##` made this gate fail on every patch
  // release - including v1.3.4, where it was the only red check.
  const sections = [...changelog.matchAll(/^#{2,3} \[?(\d+\.\d+\.\d+[^\]\s]*)\]?/gm)].map((m) => m[1]);
  if (sections.length === 0) {
    findings.push('CHANGELOG.md: no version section found');
  } else if (sections[0] !== version) {
    findings.push(
      `CHANGELOG.md: the newest section is ${sections[0]}, package.json says ${version}. ` +
        'The release workflow refuses to publish a tag without its notes — bump them together.',
    );
  }
}

// ── 7: no hardcoded versioned tarball URLs in release documentation ─────
// The public channel must point at the alias (`dominus-oss.tgz`), never at
// a `dominus-oss-X.Y.Z.tgz` that is one bump away from a 404. Versioned
// tarballs belong in historical ADRs, not in the instructions a reader
// follows today.
const RELEASE_DOCS = [
  'README.md',
  'docs/releases/npm-publishing.md',
  'docs/releases/cloud-launch-readiness.md',
  'docs/releases/launch-checklist.md',
];
const versionedTarball = /dominus-oss-\d+\.\d+\.\d+(?:[^\]\s]*)?\.tgz/;
for (const doc of RELEASE_DOCS) {
  const text = read(doc);
  if (!text) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!versionedTarball.test(line)) continue;
    findings.push(
      `${doc}:${i + 1} hardcodes a versioned tarball URL (${line.trim().slice(0, 120)}…). ` +
        'Use the versionless alias `dominus-oss.tgz` instead; versioned tarballs ' +
        'belong in historical ADRs, not in the instructions a reader follows.',
    );
  }
}

report();


function report() {
  if (findings.length > 0) {
    console.error(`check-release-consistency: FAIL — ${findings.length} drift(s) found`);
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.error(`check-release-consistency: OK — the repository is consistent at v${version}`);
}
