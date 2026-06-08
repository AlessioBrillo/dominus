import type Database from 'better-sqlite3';
import type { ScoringWeights } from '../weights.js';
import { DEFAULT_WEIGHTS } from '../weights.js';
import type { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type {
  BacktestSignalsRepository,
  BacktestSignal,
} from '../../db/repositories/backtest-signals-repository.js';
import type {
  SignalName,
  SignalPredictiveness,
  SignalScores,
  WeightSuggestion,
  WeightSuggestionReport,
} from './types.js';
import { SIGNAL_NAMES } from './types.js';

const HIGH_THRESHOLD = 0.5;
const MIN_BUCKET_SIZE = 2;
const DELTA_STEP = 0.02;
const MAX_ABS_DELTA = 0.05;
const MIN_LIFT_EUR = 50;
const WEIGHT_SUM_TOLERANCE = 0.001;
const MIN_SAMPLE_SIZE = 5;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Consume the backtest_signals table + a scoring_runs lookup, and propose
 * per-signal weight adjustments.
 *
 * Algorithm (deliberately simple, per ADR-0009):
 *  1. For each signal, split the sample into "high" (score >= 0.5) and
 *     "low" (score < 0.5).
 *  2. Compute the lift = mean(realised) in high − mean(realised) in low.
 *  3. If both buckets have n >= 2 and |lift| >= €50:
 *       - lift > 0 → propose +0.02 (capped at +0.05)
 *       - lift < 0 → propose -0.02 (capped at -0.05)
 *     else: hold (return delta = 0 with a clear rationale).
 *  4. Renormalise so the four suggested weights still sum to 1.0
 *     (operator's "principle 5" — weights must not drift into a regime
 *     the operator didn't approve).
 *  5. Refuse to suggest anything when the sample is too small (n < 5)
 *     — there is no statistical honesty in 4 data points.
 *
 * The suggester does NOT write weights anywhere. It returns a
 * WeightSuggestionReport; the CLI can call `--apply` to persist the
 * suggestion to `data/weights-override.json`, which the engine picks
 * up only if `SCORING_WEIGHTS_OVERRIDE` env is set. Two explicit gates
 * between suggestion and activation.
 */
export class WeightSuggester {
  constructor(
    private readonly db: Database.Database,
    private readonly backtestRepo: BacktestSignalsRepository,
    private readonly scoringRepo: ScoringRepository,
    private readonly currentWeights: ScoringWeights = DEFAULT_WEIGHTS,
  ) {}

  suggest(): WeightSuggestionReport {
    const signals = this.backtestRepo.findAll();
    const sampleSize = signals.length;
    const warnings: string[] = [];
    const generatedAt = new Date().toISOString();

    if (sampleSize < MIN_SAMPLE_SIZE) {
      warnings.push(
        `Sample size ${sampleSize} is below the ${MIN_SAMPLE_SIZE} minimum; no weight changes recommended.`,
      );
      const suggestions = SIGNAL_NAMES.map((signal) =>
        this.holdSuggestion(signal, 'insufficient sample size'),
      );
      return this.buildReport(generatedAt, sampleSize, suggestions, warnings);
    }

    const lookup = this.indexSignalsByRun(signals);
    const predictiveness: Record<SignalName, SignalPredictiveness> = {
      intrinsic: {
        signal: 'intrinsic',
        highMeanRealised: 0,
        highN: 0,
        lowMeanRealised: 0,
        lowN: 0,
        lift: 0,
      },
      commercial: {
        signal: 'commercial',
        highMeanRealised: 0,
        highN: 0,
        lowMeanRealised: 0,
        lowN: 0,
        lift: 0,
      },
      market: {
        signal: 'market',
        highMeanRealised: 0,
        highN: 0,
        lowMeanRealised: 0,
        lowN: 0,
        lift: 0,
      },
      expiry: {
        signal: 'expiry',
        highMeanRealised: 0,
        highN: 0,
        lowMeanRealised: 0,
        lowN: 0,
        lift: 0,
      },
    };

    for (const signal of SIGNAL_NAMES) {
      predictiveness[signal] = this.computePredictiveness(signal, signals, lookup);
    }

    const rawSuggestions = SIGNAL_NAMES.map((signal) =>
      this.rawSuggestionFor(signal, predictiveness[signal]),
    );

    const totalRawDelta = rawSuggestions.reduce((acc, s) => acc + s.delta, 0);
    let totalCurrent = 0;
    for (const s of SIGNAL_NAMES) totalCurrent += this.currentWeights[s];

    const renormScale = totalCurrent === 0 ? 0 : totalCurrent / (totalCurrent + totalRawDelta);

    const suggestions: WeightSuggestion[] = rawSuggestions.map((s) => {
      const suggested = Math.max(0, this.currentWeights[s.signal] + s.delta) * renormScale;
      const rounded = Math.round(suggested * 1000) / 1000;
      return { ...s, suggestedWeight: rounded };
    });

    const totalSuggested = suggestions.reduce((acc, s) => acc + s.suggestedWeight, 0);
    const sumsToOne = Math.abs(totalSuggested - 1) <= WEIGHT_SUM_TOLERANCE;
    if (!sumsToOne) {
      warnings.push(
        `Suggested weights sum to ${totalSuggested.toFixed(4)} (expected 1.0 ± ${WEIGHT_SUM_TOLERANCE}). Refusing to apply.`,
      );
    }

    return {
      generatedAt,
      sampleSize,
      totalCurrentWeight: Math.round(totalCurrent * 1000) / 1000,
      totalSuggestedWeight: Math.round(totalSuggested * 1000) / 1000,
      suggestions,
      sumsToOne,
      warnings,
    };
  }

  private indexSignalsByRun(signals: BacktestSignal[]): Map<number, SignalScores> {
    const out = new Map<number, SignalScores>();
    for (const s of signals) {
      if (s.id === undefined) continue;
      const candidate = this.db
        .prepare('SELECT id FROM candidates WHERE domain = ?')
        .get(s.domain) as { id: number } | undefined;
      if (candidate === undefined) continue;
      const row = this.scoringRepo.findByRunId(s.scoringRunId, candidate.id);
      if (row === null) continue;
      out.set(s.id, {
        intrinsic: row.intrinsic_score,
        commercial: row.commercial_score,
        market: row.market_score,
        expiry: row.expiry_score,
      });
    }
    return out;
  }

  private computePredictiveness(
    signal: SignalName,
    signals: BacktestSignal[],
    lookup: Map<number, SignalScores>,
  ): SignalPredictiveness {
    const high: number[] = [];
    const low: number[] = [];
    for (const s of signals) {
      if (s.id === undefined) continue;
      const scores = lookup.get(s.id);
      if (scores === undefined) continue;
      const score = scores[signal];
      if (score >= HIGH_THRESHOLD) high.push(s.actualSalePriceEur);
      else low.push(s.actualSalePriceEur);
    }
    const highMean = mean(high);
    const lowMean = mean(low);
    return {
      signal,
      highMeanRealised: Math.round(highMean * 100) / 100,
      highN: high.length,
      lowMeanRealised: Math.round(lowMean * 100) / 100,
      lowN: low.length,
      lift: Math.round((highMean - lowMean) * 100) / 100,
    };
  }

  private rawSuggestionFor(signal: SignalName, p: SignalPredictiveness): WeightSuggestion {
    if (p.highN < MIN_BUCKET_SIZE || p.lowN < MIN_BUCKET_SIZE) {
      return this.holdSuggestion(
        signal,
        `buckets too small (high=${p.highN}, low=${p.lowN}, need ${MIN_BUCKET_SIZE} each)`,
      );
    }
    if (Math.abs(p.lift) < MIN_LIFT_EUR) {
      return this.holdSuggestion(
        signal,
        `lift €${p.lift.toFixed(0)} below €${MIN_LIFT_EUR} threshold`,
      );
    }
    const direction = p.lift > 0 ? 1 : -1;
    const rawDelta = direction * DELTA_STEP;
    const delta = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), MAX_ABS_DELTA);
    const action: WeightSuggestion['action'] = direction > 0 ? 'apply' : 'revert';
    const rationale =
      direction > 0
        ? `high-${signal} sold for €${p.lift.toFixed(0)} more on average → +${(delta * 100).toFixed(1)}% weight`
        : `high-${signal} sold for €${Math.abs(p.lift).toFixed(0)} less on average → ${(delta * 100).toFixed(1)}% weight`;
    return {
      signal,
      currentWeight: this.currentWeights[signal],
      suggestedWeight: 0,
      delta,
      action,
      rationale,
    };
  }

  private holdSuggestion(signal: SignalName, reason: string): WeightSuggestion {
    return {
      signal,
      currentWeight: this.currentWeights[signal],
      suggestedWeight: this.currentWeights[signal],
      delta: 0,
      action: 'hold',
      rationale: `hold: ${reason}`,
    };
  }

  private buildReport(
    generatedAt: string,
    sampleSize: number,
    suggestions: WeightSuggestion[],
    warnings: string[],
  ): WeightSuggestionReport {
    const totalCurrent = suggestions.reduce((acc, s) => acc + s.currentWeight, 0);
    const totalSuggested = suggestions.reduce((acc, s) => acc + s.suggestedWeight, 0);
    return {
      generatedAt,
      sampleSize,
      totalCurrentWeight: Math.round(totalCurrent * 1000) / 1000,
      totalSuggestedWeight: Math.round(totalSuggested * 1000) / 1000,
      suggestions,
      sumsToOne: Math.abs(totalCurrent - totalSuggested) <= WEIGHT_SUM_TOLERANCE,
      warnings,
    };
  }
}
