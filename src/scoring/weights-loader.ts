import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_WEIGHTS,
  DEFAULT_FALLBACK_WEIGHTS,
  SIGNAL_DATA_THRESHOLD,
  WEIGHT_RECOMMEND_THRESHOLD,
  MIN_EFFECTIVE_RECOMMEND_THRESHOLD,
  MIN_EFFECTIVE_CONFIDENCE_THRESHOLD,
  type ScoringWeights,
} from './weights.js';
import type { SignalAvailability, SignalName } from '../types/score.js';

export const WEIGHTS_OVERRIDE_SUM_TOLERANCE = 0.001;

/**
 * Given a map of which signals have real data, compute the effective
 * weights to use for weightedScore calculation.
 *
 * Algorithm (conservative redistribution):
 * 1. If ≥70% of default weight has live data, return DEFAULT_WEIGHTS as-is.
 * 2. Otherwise, zero out unavailable signals and redistribute their weight
 *    to available intrinsic and/or expiry signals proportionally to the
 *    DEFAULT_FALLBACK_WEIGHTS ratios.
 *
 * This ensures the recommendation threshold remains achievable even when
 * external data providers (keyword, market) return no data, while never
 * fabricating signal quality — it simply trusts the available signals more.
 */
export function resolveEffectiveWeights(
  availability: SignalAvailability,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  fallback: ScoringWeights = DEFAULT_FALLBACK_WEIGHTS,
): ScoringWeights {
  const availableDefaultWeight = sumAvailable(weights, availability);

  if (availableDefaultWeight >= SIGNAL_DATA_THRESHOLD) {
    return { ...weights };
  }

  const result = { ...weights };
  const unavailableSignals = (Object.keys(availability) as SignalName[]).filter(
    (s) => !availability[s],
  );

  for (const signal of unavailableSignals) {
    result[signal] = 0;
  }

  const toRedistribute = 1 - availableDefaultWeight;
  const availableIntrinsic = availability.intrinsic;
  const availableExpiry = availability.expiry;

  if (availableIntrinsic && availableExpiry) {
    const fallbackTotal = fallback.intrinsic + fallback.expiry;
    result.intrinsic += toRedistribute * (fallback.intrinsic / fallbackTotal);
    result.expiry += toRedistribute * (fallback.expiry / fallbackTotal);
  } else if (availableIntrinsic) {
    result.intrinsic += toRedistribute;
  } else if (availableExpiry) {
    result.expiry += toRedistribute;
  }

  return result;
}

/**
 * Compute dynamic recommendation and confidence thresholds based on
 * signal availability.
 *
 * When signal data is sparse, the thresholds are lowered proportionally
 * so that recommendations remain achievable. When all signals have data,
 * the original thresholds are used.
 *
 * Returns { effectiveRecommendThreshold, effectiveConfidenceThreshold }.
 */
export function computeEffectiveThresholds(
  availability: SignalAvailability,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): {
  effectiveRecommendThreshold: number;
  effectiveConfidenceThreshold: number;
} {
  const availableWeight = sumAvailable(weights, availability);
  const ratio = Math.min(1, availableWeight / SIGNAL_DATA_THRESHOLD);

  const recommendRange = WEIGHT_RECOMMEND_THRESHOLD - MIN_EFFECTIVE_RECOMMEND_THRESHOLD;
  const effectiveRecommendThreshold = MIN_EFFECTIVE_RECOMMEND_THRESHOLD + recommendRange * ratio;

  const confidenceRange = 0.3 - MIN_EFFECTIVE_CONFIDENCE_THRESHOLD;
  const effectiveConfidenceThreshold = MIN_EFFECTIVE_CONFIDENCE_THRESHOLD + confidenceRange * ratio;

  return {
    effectiveRecommendThreshold: round2(effectiveRecommendThreshold),
    effectiveConfidenceThreshold: round2(effectiveConfidenceThreshold),
  };
}

function sumAvailable(weights: ScoringWeights, availability: SignalAvailability): number {
  return (
    (availability.intrinsic ? weights.intrinsic : 0) +
    (availability.commercial ? weights.commercial : 0) +
    (availability.market ? weights.market : 0) +
    (availability.expiry ? weights.expiry : 0)
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

/**
 * Re-read the weights override file at runtime. Returns the parsed weights
 * or DEFAULT_WEIGHTS on any error (fail-soft). Used by the auto-tuner after
 * writing a new override, so the scoring engine picks it up without restart.
 */
export function reloadWeights(overridePath: string | undefined): ScoringWeights {
  return loadWeights(overridePath);
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
