#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Workflow gate: the GitHub Actions files must parse, and the two rules
// that cost a push to master.
//
// A workflow that does not parse fails at RUN time, on the event that
// triggers it — which for the deploy workflow is the push to master.
// The first version of the staging/production split used
// `environment: ${{ matrix.environment }}`; the environment name is
// resolved before the matrix is expanded, the expression is invalid, and
// the workflow failed to parse. Nothing caught it: the pull request's CI
// does not run the deploy workflow, so the defect was found when it was
// already on master.
//
// Two checks:
//   1. every workflow and composite action parses as YAML;
//   2. no job's environment name depends on the matrix.
//
// Usage:
//   node scripts/check-workflows.mjs
//   exit 0 = green, exit 1 = a workflow is broken

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';

const root = process.cwd();
const findings = [];

function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      collect(full, out);
    } else if (/\.(ya?ml)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...collect(join(root, '.github', 'workflows')),
  ...collect(join(root, '.github', 'actions')),
];

if (files.length === 0) {
  findings.push('no workflow files found — the glob is wrong, or the folder is gone');
}

for (const file of files) {
  const rel = file.replace(`${root}\\`, '').replace(`${root}/`, '');
  const content = readFileSync(file, 'utf8');

  // 1. It must parse. Prettier is a parser as much as a formatter: a
  //    syntax error throws, while a formatting difference only makes
  //    check() false.
  try {
    await prettier.format(content, { parser: 'yaml' });
  } catch (err) {
    findings.push(`${rel}: does not parse as YAML — ${err.message.split('\n')[0]}`);
    continue;
  }

  // 2. The environment name must not depend on the matrix: it is
  //    resolved before the matrix is expanded, so the expression is
  //    invalid and the workflow fails to parse at run time.
  //    The comment lines are dropped first: the rule is often explained
  //    in a comment that quotes the forbidden expression.
  const code = content
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const matrixInEnvironment = /environment:\s*(?:\n\s+name:\s*)?[^\n]*matrix\./m;
  if (matrixInEnvironment.test(code)) {
    findings.push(
      `${rel}: a job's environment depends on the matrix. The environment name is resolved ` +
        'before the matrix is expanded: use one job per environment.',
    );
  }
}

if (findings.length > 0) {
  console.error(`check-workflows: FAIL — ${findings.length} problem(s)`);
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.error(`check-workflows: OK — ${files.length} workflow file(s) parse and declare no matrix environment`);
