// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Tests for scripts/finalize-dist.mjs, which turns the raw `tsc` output into
// a complete distributable: it stages the built SPA under dist/web, copies
// runtime JSON data assets into the tree, and prunes compiled test suites.
//
// Each case builds an isolated fake dist/ in a temp directory and invokes the
// script with the working directory set there, so the real script is
// exercised against a fixture rather than a copy. The script resolves paths
// relative to its own location, so the fixture tree is placed under a
// scripts/ subdirectory to mirror the real layout.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/finalize-dist.mjs', import.meta.url));

/**
 * Root of a fake repository, mirrored at the same depth as the real one.
 *
 * `finalize-dist.mjs` derives the project root from its own location
 * (`../..` relative to the script), not from the current directory. So a
 * fixture has to sit three levels deep — `<tmp>/<bucket>/repo/scripts/` —
 * and the script must be copied into it, otherwise the script would prune
 * the real `dist/` in the repository. The bucket is ignored; it exists only
 * because the script reads its own parent, not cwd.
 */
const BUCKET = 'pkg';

function fakeRepo(files: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), 'finalize-dist-')), BUCKET, 'repo');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'scripts', 'finalize-dist.mjs'));
  // The script refuses to run without src/ (it copies JSON assets from
  // there), so every fixture ships an empty one.
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function runFinalize(root: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [join(root, 'scripts', 'finalize-dist.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('finalize-dist script', () => {
  it('prunes compiled test suites inside __tests__ directories', () => {
    const root = fakeRepo({
      'dist/portfolio/index.js': 'export {};\n',
      'dist/portfolio/index.d.ts': 'export {};\n',
      'dist/portfolio/__tests__/index.test.js': 'it("x", () => {});\n',
      'dist/portfolio/__tests__/index.test.d.ts': 'export {};\n',
    });
    runFinalize(root);

    expect(() => readFileSync(join(root, 'dist/portfolio/index.js'), 'utf8')).not.toThrow();
    expect(() =>
      readFileSync(join(root, 'dist/portfolio/__tests__/index.test.js'), 'utf8'),
    ).toThrow();
    expect(() =>
      readFileSync(join(root, 'dist/portfolio/__tests__/index.test.d.ts'), 'utf8'),
    ).toThrow();
  });

  it('prunes test files that sit next to the module they test', () => {
    // src/portfolio/expiry-watcher.test.ts compiles to dist/portfolio/
    // expiry-watcher.test.js — not inside a __tests__ directory, so the
    // directory sweep cannot see it. `npm pack` shipped it until this case
    // existed.
    const root = fakeRepo({
      'dist/portfolio/expiry-watcher.js': 'export {};\n',
      'dist/portfolio/expiry-watcher.test.js': 'it("x", () => {});\n',
      'dist/db/provider/postgres-adapter.js': 'export {};\n',
      'dist/db/provider/postgres-adapter.test.js': 'it("x", () => {});\n',
    });
    runFinalize(root);

    expect(() =>
      readFileSync(join(root, 'dist/portfolio/expiry-watcher.js'), 'utf8'),
    ).not.toThrow();
    expect(() =>
      readFileSync(join(root, 'dist/portfolio/expiry-watcher.test.js'), 'utf8'),
    ).toThrow();
    expect(() =>
      readFileSync(join(root, 'dist/db/provider/postgres-adapter.test.js'), 'utf8'),
    ).toThrow();
  });

  it('stages the built SPA under dist/web when frontend/dist exists', () => {
    const root = fakeRepo({
      'dist/index.js': 'export {};\n',
      'frontend/dist/index.html': '<html>spa</html>\n',
      'frontend/dist/assets/app.js': 'console.log(1)\n',
    });
    const result = runFinalize(root);

    expect(result.status).toBe(0);
    expect(() => readFileSync(join(root, 'dist/web/index.html'), 'utf8')).not.toThrow();
    expect(() => readFileSync(join(root, 'dist/web/assets/app.js'), 'utf8')).not.toThrow();
    // The staged copy is a copy, not a move: frontend/dist must survive.
    expect(() => readFileSync(join(root, 'frontend/dist/index.html'), 'utf8')).not.toThrow();
  });

  it('warns but does not fail when frontend/dist is absent', () => {
    // A backend-only build (npm run build without build:frontend) is a
    // legitimate partial state; check:pack catches it as a missing file
    // later, so finalize-dist must not be the gate.
    const root = fakeRepo({ 'dist/index.js': 'export {};\n' });
    const result = runFinalize(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/frontend\/dist not found/);
    // It is a warning, not a failure: check:pack is the gate that rejects a
    // tarball without the SPA.
    expect(result.stdout).not.toMatch(/FAILED/);
  });

  it('fails when dist/ is missing entirely', () => {
    const root = fakeRepo({ 'placeholder.txt': 'x\n' });
    const result = runFinalize(root);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/dist\/ not found/);
  });

  it('reports how many JSON assets were copied and tests pruned', () => {
    const root = fakeRepo({
      'src/providers/dns/parking-ips.json': '[]\n',
      'dist/providers/dns/unbound-resolver.js': 'export {};\n',
      'dist/providers/dns/__tests__/x.test.js': 'it("x", () => {});\n',
    });
    const result = runFinalize(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/copied 1 JSON asset/);
    expect(result.stdout).toMatch(/pruned 1 compiled test file/);
    // The asset must land at the path the runtime code resolves.
    expect(() =>
      readFileSync(join(root, 'dist/providers/dns/parking-ips.json'), 'utf8'),
    ).not.toThrow();
  });

  it('is idempotent', () => {
    const root = fakeRepo({
      'src/a.json': '{}\n',
      'dist/index.js': 'export {};\n',
      'dist/x.test.js': 'it("x", () => {});\n',
    });
    const first = runFinalize(root);
    const second = runFinalize(root);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(() => readFileSync(join(root, 'dist/x.test.js'), 'utf8')).toThrow();
    expect(() => readFileSync(join(root, 'dist/a.json'), 'utf8')).not.toThrow();
  });
});
