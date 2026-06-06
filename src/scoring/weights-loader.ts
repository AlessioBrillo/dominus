import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_WEIGHTS, type ScoringWeights } from './weights.js';

export const WEIGHTS_OVERRIDE_SUM_TOLERANCE = 0.001;

export class WeightsOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeightsOverrideError';
  }
}

/**
 * Load scoring weights from an operator-approved override file.
 *
 * Two-gate policy (per ADR-0009):
 *  1. The CLI writes the file (`dominus backtest suggest-weights --apply`).
 *  2. The engine only reads it if the operator sets
 *     `SCORING_WEIGHTS_OVERRIDE=<path>` in `.env`.
 *
 * The file format is the exact JSON written by the suggester:
 *   { "weights": { "intrinsic": 0.30, "commercial": 0.35, ... }, ... }
 *
 * Validation: all four signal keys present, finite numbers in [0, 1],
 * sum within 0.001 of 1.0. On any failure: log a warning and return
 * DEFAULT_WEIGHTS (fail-soft — the operator must fix the file, the
 * engine must not crash the pipeline).
 */
export function loadWeights(overridePath: string | undefined): ScoringWeights {
  if (overridePath === undefined || overridePath === '') {
    return DEFAULT_WEIGHTS;
  }

  const absPath = resolve(process.cwd(), overridePath);
  if (!existsSync(absPath)) {
    process.stderr.write(
      `[dominus] SCORING_WEIGHTS_OVERRIDE points to a missing file: ${absPath}; using defaults\n`,
    );
    return DEFAULT_WEIGHTS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[dominus] SCORING_WEIGHTS_OVERRIDE file is not valid JSON (${message}); using defaults\n`,
    );
    return DEFAULT_WEIGHTS;
  }

  return validateOverrideOrDefault(parsed);
}

function validateOverrideOrDefault(parsed: unknown): ScoringWeights {
  if (typeof parsed !== 'object' || parsed === null) {
    process.stderr.write('[dominus] SCORING_WEIGHTS_OVERRIDE is not an object; using defaults\n');
    return DEFAULT_WEIGHTS;
  }
  const obj = parsed as Record<string, unknown>;
  const weights = obj['weights'];
  if (typeof weights !== 'object' || weights === null) {
    process.stderr.write('[dominus] SCORING_WEIGHTS_OVERRIDE.weights is missing; using defaults\n');
    return DEFAULT_WEIGHTS;
  }
  const w = weights as Record<string, unknown>;

  const requiredKeys: Array<keyof ScoringWeights> = ['intrinsic', 'commercial', 'market', 'expiry'];
  const values: number[] = [];
  for (const key of requiredKeys) {
    const v = w[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      process.stderr.write(
        `[dominus] SCORING_WEIGHTS_OVERRIDE.weights.${key} is invalid (${String(v)}); using defaults\n`,
      );
      return DEFAULT_WEIGHTS;
    }
    values.push(v);
  }

  const sum = values.reduce((acc, v) => acc + v, 0);
  if (Math.abs(sum - 1) > WEIGHTS_OVERRIDE_SUM_TOLERANCE) {
    process.stderr.write(
      `[dominus] SCORING_WEIGHTS_OVERRIDE.weights sum to ${sum.toFixed(4)} (expected 1.0 ± ${WEIGHTS_OVERRIDE_SUM_TOLERANCE}); using defaults\n`,
    );
    return DEFAULT_WEIGHTS;
  }

  return {
    intrinsic: values[0]!,
    commercial: values[1]!,
    market: values[2]!,
    expiry: values[3]!,
  };
}
