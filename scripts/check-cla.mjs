#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contributor License Agreement gate.
 *
 * The commercial licence is one of the two ways to use DOMINUS. It is only
 * defensible if the provenance of every contribution is clean: a DCO is a
 * certification, not a copyright licence, so a CLA signed by each contributor
 * is what makes the dual-licence promise true.
 *
 * This check is the Woodpecker counterpart of .github/workflows/cla.yml. The
 * GitHub Actions workflow cannot be the gate: Actions is billing-blocked on
 * this repository. Woodpecker exposes the commit author in CI_COMMIT_AUTHOR;
 * the pipeline passes it as CLA_AUTHOR to keep this script independent of the
 * CI provider's variable names and testable on a workstation.
 *
 * When no author is supplied (ci-local, a manual run) the author check is
 * skipped and the structural checks still run: the agreement, the registry
 * and the workflow must exist, or a silent regression would leave the gate
 * green while nobody can tell whether contributions are covered.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relPath) =>
  existsSync(join(root, relPath)) ? readFileSync(join(root, relPath), 'utf-8') : '';

const failures = [];
if (!read('CLA.md').includes('Grant of Copyright License')) {
  failures.push('CLA.md does not contain the copyright grant');
}
if (!read('CONTRIBUTORS.md').includes('## CLA Signers')) {
  failures.push('CONTRIBUTORS.md has no CLA Signers registry');
}
if (!read('.github/workflows/cla.yml').includes('CLA Signers')) {
  failures.push('the GitHub CLA workflow no longer reads the signer registry');
}

const author = (process.env.CLA_AUTHOR ?? '').trim();
const isBot = author.endsWith('[bot]');
const signersSection = read('CONTRIBUTORS.md').split('## CLA Signers')[1] ?? '';
const signers = [...signersSection.matchAll(/- `([^`]+)`/g)].map((m) => m[1]);

if (author !== '' && !isBot && !signers.includes(author)) {
  failures.push(
    `No signed CLA on file for ${author}. Read CLA.md and add your GitHub username to CONTRIBUTORS.md before opening a pull request.`,
  );
}

if (failures.length > 0) {
  console.error(`check-cla: FAILED (${failures.length} problem(s))`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  author === '' || isBot
    ? `check-cla: OK — CLA and registry present; author check ${author === '' ? 'skipped (no author supplied)' : `exempt (${author})`}`
    : `check-cla: OK — signed CLA on file for ${author}`,
);
