// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The running version, read once from the package.json that ships with the
 * build (src/ and dist/ both sit one level below the project root). Single
 * source of truth for documents that must not drift from a release, e.g. the
 * OpenAPI `info.version`.
 */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const APP_VERSION: string = readVersion();
