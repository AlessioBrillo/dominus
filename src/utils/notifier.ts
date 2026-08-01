// SPDX-License-Identifier: AGPL-3.0-only
export function writeError(prefix: string, err: unknown): void {
  process.stderr.write(`${prefix}: ${err instanceof Error ? err.message : String(err)}\n`);
}
