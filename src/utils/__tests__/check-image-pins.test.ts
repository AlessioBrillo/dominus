// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Guard tests for scripts/check-image-pins.mjs — the static supply-chain
// gate that rejects floating or unpinned container image references.
// Each case spawns the real script against a fixture tree so the test
// exercises the shipped artifact, not a copy.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/check-image-pins.mjs', import.meta.url));

function fixtureTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'image-pins-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runGuard(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = execFileSync('node', [SCRIPT, cwd], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: 0, stdout: result, stderr: '' };
}

function runGuardFail(cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    execFileSync('node', [SCRIPT, cwd], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('guard exited 0 on an unpinned tree');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('check-image-pins guard', () => {
  it('accepts a Dockerfile whose base stages are digest-pinned or ARG-driven', () => {
    const dir = fixtureTree({
      Dockerfile: [
        'ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
        'FROM ${NODE_IMAGE} AS deps',
        'FROM ${NODE_IMAGE}',
        'FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166191e36a5501df7a3aa32',
      ].join('\n'),
    });
    const result = runGuard(dir);
    expect(result.stdout).not.toContain('FAIL');
  });

  it('rejects a Dockerfile FROM stage that is not pinned and not ARG-driven', () => {
    const dir = fixtureTree({ Dockerfile: 'FROM node:22-alpine\nRUN echo hi\n' });
    const result = runGuardFail(dir);
    expect(result.stderr).toContain('node:22-alpine');
    expect(result.stderr).toContain('Dockerfile');
  });

  it('rejects an unpinned ARG*IMAGE default', () => {
    const dir = fixtureTree({
      Dockerfile: 'ARG NODE_IMAGE=node:23-alpine\nFROM ${NODE_IMAGE}\n',
    });
    const result = runGuardFail(dir);
    expect(result.stderr).toContain('NODE_IMAGE');
  });

  it('accepts compose files with digest-pinned and locally built images', () => {
    const dir = fixtureTree({
      'docker-compose.prod.yml': [
        'services:',
        '  db:',
        '    image: postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777',
        '  api:',
        '    image: dominus-api:latest',
      ].join('\n'),
    });
    const result = runGuard(dir);
    expect(result.stdout).not.toContain('FAIL');
  });

  it('rejects a floating external tag in compose (postgres:16-alpine)', () => {
    const dir = fixtureTree({
      'docker-compose.prod.yml': 'services:\n  db:\n    image: postgres:16-alpine\n',
    });
    const result = runGuardFail(dir);
    expect(result.stderr).toContain('postgres:16-alpine');
  });

  it('accepts compose image refs driven by environment variables', () => {
    const dir = fixtureTree({
      'docker-compose.prod.yml':
        'services:\n  api:\n    image: ghcr.io/alessiobrillo/dominus:${DOMINUS_IMAGE_TAG:-master}\n',
    });
    const result = runGuard(dir);
    expect(result.stdout).not.toContain('FAIL');
  });

  it('rejects a :latest image tag in a Kubernetes manifest', () => {
    const dir = fixtureTree({
      'deploy/deployment.yaml': '      image: ghcr.io/alessiobrillo/dominus:latest\n',
    });
    const result = runGuardFail(dir);
    expect(result.stderr).toContain('dominus:latest');
  });

  it('accepts semver or sha- prefixed tags in Kubernetes manifests', () => {
    const dir = fixtureTree({
      'deploy/deployment.yaml': '      image: ghcr.io/alessiobrillo/dominus:v0.10.1\n',
    });
    const result = runGuard(dir);
    expect(result.stdout).not.toContain('FAIL');
  });
});
