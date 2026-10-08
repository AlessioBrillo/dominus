// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENAPI_SPEC } from '../openapi-spec.js';

/**
 * Every route the protected API mounts must appear in the OpenAPI document,
 * and vice versa. The spec had drifted badly (whole routers missing, a wrong
 * path); this keeps it honest by reading the same source the server mounts:
 *
 *   src/index.ts          protectedRouter.use('/prefix', createXRouter(...))
 *   src/api/routes/*.ts   router.get('/sub', ...)  ->  GET /prefix/sub
 */
const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..');
const srcIndex = readFileSync(join(apiDir, '..', 'index.ts'), 'utf8');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Router factory name -> mount prefix (protected API only). */
function mountedRouters(): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const m of srcIndex.matchAll(
    /protectedRouter\.use\(\s*'(\/[^']*)'\s*,[\s\S]*?\b(create\w+Router)\(/g,
  )) {
    mounts.set(m[2]!, m[1]!);
  }
  return mounts;
}

function routeFileFor(factory: string): string | undefined {
  const dir = join(apiDir, 'routes');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .find((f) => readFileSync(join(dir, f), 'utf8').includes(`export function ${factory}(`));
}

function toOpenApiPath(prefix: string, sub: string): string {
  const joined = `${prefix}${sub === '/' ? '' : sub}` || '/';
  return joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function implementedOperations(): string[] {
  const ops: string[] = [];
  for (const [factory, prefix] of mountedRouters()) {
    const file = routeFileFor(factory);
    if (!file) continue;
    const src = readFileSync(join(apiDir, 'routes', file), 'utf8');
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      ops.push(`${m[1]!.toUpperCase()} ${toOpenApiPath(prefix, m[2]!)}`);
    }
  }
  return ops.sort();
}

function documentedOperations(): string[] {
  const paths = OPENAPI_SPEC.paths as Record<string, Record<string, unknown>>;
  const ops: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      if (item[method])
        ops.push(`${method.toUpperCase()} ${path.replace(/^\/api\/v1(?=\/|$)/, '') || '/'}`);
    }
  }
  return ops.sort();
}

/** Routes intentionally not in the public contract. */
const UNDOCUMENTED = new Set<string>([]);

describe('OpenAPI coverage', () => {
  it('finds the protected routers it is supposed to compare', () => {
    // Guards the parser: if the mount style changes this must fail loudly
    // instead of silently comparing nothing.
    expect(mountedRouters().size).toBeGreaterThan(20);
    expect(implementedOperations().length).toBeGreaterThan(80);
  });

  it('documents every implemented route', () => {
    const documented = new Set(documentedOperations());
    const missing = implementedOperations().filter(
      (op) => !documented.has(op) && !UNDOCUMENTED.has(op),
    );
    expect(missing).toEqual([]);
  });

  it('documents no route that does not exist', () => {
    const implemented = new Set(implementedOperations());
    // Public/unauthenticated and health endpoints live outside protectedRouter.
    const outsideProtected = (op: string): boolean =>
      /^\w+ \/(public|health|docs|auth|api\/health)(\/|$)/.test(op) || op.includes('/metrics');
    const phantom = documentedOperations().filter(
      (op) => !implemented.has(op) && !outsideProtected(op),
    );
    expect(phantom).toEqual([]);
  });

  it('reports the package.json version, not a hard-coded one', () => {
    const pkg = JSON.parse(readFileSync(join(apiDir, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect((OPENAPI_SPEC.info as { version: string }).version).toBe(pkg.version);
  });
});
