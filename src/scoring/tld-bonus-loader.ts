import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_TLD_BONUS } from './weights.js';

export class TldBonusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TldBonusError';
  }
}

export function loadTldBonuses(overridePath: string | undefined): Record<string, number> {
  if (overridePath === undefined || overridePath === '') {
    return DEFAULT_TLD_BONUS;
  }

  const absPath = resolve(process.cwd(), overridePath);
  if (!existsSync(absPath)) {
    process.stderr.write(
      `[dominus] TLD_BONUSES_PATH points to a missing file: ${absPath}; using default TLD bonuses\n`,
    );
    return DEFAULT_TLD_BONUS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[dominus] TLD_BONUSES_PATH file is not valid JSON (${message}); using default TLD bonuses\n`,
    );
    return DEFAULT_TLD_BONUS;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    process.stderr.write(
      '[dominus] TLD_BONUSES_PATH is not an object; using default TLD bonuses\n',
    );
    return DEFAULT_TLD_BONUS;
  }

  const custom = parsed as Record<string, unknown>;
  const merged: Record<string, number> = { ...DEFAULT_TLD_BONUS };

  for (const [tld, value] of Object.entries(custom)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      const normalized = tld.startsWith('.') ? tld : `.${tld}`;
      merged[normalized] = value;
    } else {
      process.stderr.write(
        `[dominus] TLD_BONUSES_PATH: skipping invalid value for "${tld}" (must be a number between 0 and 1)\n`,
      );
    }
  }

  return merged;
}
