// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Guards the version readers that resolve their package.json by walking up
// a fixed number of directories.
//
// `dominus --version` printed 0.0.0 from an installed copy of the package.
// src/cli/index.ts walked up three levels, but its compiled location is
// dist/cli/index.js, whose directory is only two below the project root —
// so the third level resolved above the root, the read threw, and the catch
// returned the '0.0.0' placeholder. Three levels is also what the source
// position looks like at a glance (src/cli/index.ts sits "at depth two, so
// three should be enough"), which is why the wrong count survived: the
// other three readers sit one directory deeper, and for them three is
// correct.
//
// The checks read the sources, not the compiled output: CI runs the test job
// before the build job, so dist/ is absent when these assert. Each source's
// level count is compared against the depth of the path it compiles to,
// which is the invariant that actually matters — a file that guesses wrong
// fails here whether or not the tree has been compiled.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pkgVersion = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }
).version;

/**
 * The path a source module compiles to. `tsc` mirrors src/ under dist/, so
 * src/a/b/c.ts -> dist/a/b/c.js.
 */
function compiledPathOf(sourceRel: string): string {
  return relative(process.cwd(), join('dist', relative('src', sourceRel))).replace(/\.ts$/, '.js');
}

/** Levels a module must walk up from its own directory to reach the root. */
function levelsRequired(compiledPath: string): number {
  return dirname(compiledPath).split(/[\\/]/).length;
}

/** The `'..'` segments a source module actually walks. */
function levelsInSource(sourceRel: string): number {
  const source = readFileSync(join(root, sourceRel), 'utf-8');
  // The base may be `__dirname` or `here`, so allow leading underscores.
  const call = source.match(/join\(\s*[A-Za-z_]+\s*,\s*((?:'\.\.'\s*,\s*)+)'package\.json'/);
  if (!call || call[1] === undefined) return -1;
  return (call[1].match(/'\.\.'/g) ?? []).length;
}

describe('version resolution', () => {
  it('found a version to assert against', () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Exhaustive for the version readers. Adding one means adding it here,
  // which is the point: a mis-counted walk then fails the suite instead of
  // silently shipping `dominus --version` = 0.0.0.
  const READERS = [
    'src/version.ts', // dist/version.js — 1 level
    'src/cli/index.ts', // dist/cli/index.js — 2 levels
    'src/cli/commands/health-command.ts', // dist/cli/commands/ — 3 levels
    'src/api/routes/health.ts', // dist/api/routes/ — 3 levels
  ];

  for (const reader of READERS) {
    it(`${reader} walks up exactly the levels its compiled path requires`, () => {
      expect(levelsInSource(reader)).toBe(levelsRequired(compiledPathOf(reader)));
    });
  }

  it('src/cli/index.ts is the only reader whose count was wrong', () => {
    // Documents the exception that caused the bug, so the next reader added
    // to this list is added consciously. It is the only one placed directly
    // under src/, so it is the only one needing two rather than three.
    const required = levelsRequired(compiledPathOf('src/cli/index.ts'));
    expect(required).toBe(2);
    expect(required).not.toBe(levelsRequired(compiledPathOf('src/cli/commands/health-command.ts')));
  });
});
