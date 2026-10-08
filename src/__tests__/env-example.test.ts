// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `.env.example` is the operator-facing contract. Every key the config schema
 * reads must be documented there, and it must not advertise keys the code
 * ignores (it used to list registrar/marketplace credentials nothing read).
 */
const root = resolve(import.meta.dirname, '../..');

// Read outside the zod schema (process.env directly / compose / Terraform).
const EXTRA_ALLOWED = new Set([
  'DOMINUS_IMAGE_TAG',
  'REGISTRAR_CLOUDFLARE_API_TOKEN',
  'REGISTRAR_CLOUDFLARE_ACCOUNT_ID',
]);

function schemaKeys(): Set<string> {
  const src = readFileSync(resolve(root, 'src/config.ts'), 'utf8');
  return new Set([...src.matchAll(/^ {4}([A-Z][A-Z0-9_]{2,}): /gm)].map((m) => m[1]!));
}

function envExampleKeys(): Set<string> {
  const env = readFileSync(resolve(root, '.env.example'), 'utf8');
  return new Set([...env.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]!));
}

describe('.env.example', () => {
  it('documents every key the config schema reads', () => {
    const documented = envExampleKeys();
    const missing = [...schemaKeys()].filter((k) => !documented.has(k)).sort();
    expect(missing).toEqual([]);
  });

  it('does not advertise keys the code never reads', () => {
    const known = schemaKeys();
    const stale = [...envExampleKeys()]
      .filter((k) => !known.has(k) && !EXTRA_ALLOWED.has(k))
      .sort();
    expect(stale).toEqual([]);
  });
});
