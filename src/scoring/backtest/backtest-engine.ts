import type { DatabaseProvider } from '../../db/provider/interface.js';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { resolveTenantId } from '../../utils/tenant-context.js';
import type {
  BacktestSignalsRepository,
  BacktestSignal,
} from '../../db/repositories/backtest-signals-repository.js';
import type { Outcome } from '../../types/outcome.js';
import type {
  BacktestReport,
  CalibrationBucketStat,
  SnapshotSummary,
  DomainCostInfo,
} from './types.js';
import { CONFIDENCE_BUCKETS } from '../../db/repositories/backtest-signals-repository.js';

interface ScoringSnapshotRow {
  id: number;
  run_id: string;
  expected_value: number;
  confidence: number;
  suggested_buy_max: number;
  suggested_list_price: number;
  weighted_score: number;
  recommended: number;
  scored_at: string;
}

const SMALL_BUCKET_WARN_THRESHOLD = 10;

const ZERO_CALIBRATION: CalibrationBucketStat = {
  n: 0,
  meanAbsError: 0,
  meanRealised: 0,
  meanPredicted: 0,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Backtest engine — closes the loop between scoring predictions and
 * realised outcomes.
 *
 * Two responsibilities, exposed as separate methods so callers can
 * pick:
 *
 *  - `snapshot()` scans `outcomes` for `sold` rows, joins each to the
 *    last `scoring_runs` row whose `scored_at <= outcome.occurred_at`
 *    (point-in-time correctness), and UPSERTs the pair into
 *    `backtest_signals` (idempotent thanks to the unique index).
 *  - `report()` aggregates the snapshot table into the metrics the
 *    operator actually reads: MAE, bias, buy-max hit rate, and a
 *    per-confidence-bucket calibration table.
 *
 * Why "sold only" (per the v0.3 product decision): dropped / expired
 * / renewed outcomes are not "what did the engine predict vs reality"
 * signals — they are process outcomes. Mixing them would corrupt the
 * MAE and the confidence calibration. Sold-only is the cleanest
 * monetary truth the engine can be held to.
 */
export class BacktestEngine {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly outcomeRepo: OutcomeRepository,
    private readonly backtestRepo: BacktestSignalsRepository,
  ) {}

  /**
   * Re-derive the backtest_signals table from current outcomes and
   * scoring_runs. Idempotent. Returns a summary the CLI can print.
   */
  async snapshot(): Promise<SnapshotSummary> {
    const soldOutcomes = await this.outcomeRepo.findByType('sold');
    let inserted = 0;
    let skipped = 0;

    for (const outcome of soldOutcomes) {
      if (outcome.salePriceEur === undefined) {
        skipped++;
        continue;
      }
      try {
        const insertedNow = await this.writeSignalForOutcome(outcome);
        if (insertedNow) inserted++;
        else skipped++;
      } catch {
        skipped++;
      }
    }

    return {
      scanned: soldOutcomes.length,
      inserted,
      skipped,
    };
  }

  /**
   * Produce a BacktestReport from the current backtest_signals table.
   * Does not touch outcomes or scoring_runs — pure aggregation.
   */
  async report(): Promise<BacktestReport> {
    const signals = await this.backtestRepo.findAll();
    const sampleSize = signals.length;

    if (sampleSize === 0) {
      return {
        generatedAt: new Date().toISOString(),
        sampleSize: 0,
        excludedNoPrediction: 0,
        excludedNoOutcome: 0,
        meanAbsoluteErrorEur: 0,
        medianAbsoluteErrorEur: 0,
        biasEur: 0,
        biasPct: 0,
        buyMaxMeanAbsoluteErrorEur: 0,
        buyMaxHitRate: 0,
        calibration: {
          low: { ...ZERO_CALIBRATION },
          mid: { ...ZERO_CALIBRATION },
          high: { ...ZERO_CALIBRATION },
        },
        warnings: ['No backtest signals — run `dominus backtest snapshot` first'],
      };
    }

    const absErrors = signals.map((s) => Math.abs(s.predictedExpectedValue - s.actualSalePriceEur));
    const signedErrors = signals.map((s) => s.actualSalePriceEur - s.predictedExpectedValue);
    const buyMaxAbsErrors = signals.map((s) => Math.abs(s.predictedBuyMax - s.actualSalePriceEur));
    const buyMaxHits = signals.filter((s) => s.actualSalePriceEur > s.predictedBuyMax);

    const meanActual = mean(signals.map((s) => s.actualSalePriceEur));
    const biasEur = mean(signedErrors);
    const biasPct = meanActual === 0 ? 0 : (biasEur / meanActual) * 100;

    const warnings: string[] = [];
    const calibration: Record<string, CalibrationBucketStat> = {};
    for (const bucket of CONFIDENCE_BUCKETS) {
      const subset = signals.filter((s) => s.confidenceBucket === bucket);
      const n = subset.length;
      calibration[bucket] = {
        n,
        meanAbsError: mean(
          subset.map((s) => Math.abs(s.predictedExpectedValue - s.actualSalePriceEur)),
        ),
        meanRealised: mean(subset.map((s) => s.actualSalePriceEur)),
        meanPredicted: mean(subset.map((s) => s.predictedExpectedValue)),
      };
      if (n > 0 && n < SMALL_BUCKET_WARN_THRESHOLD) {
        warnings.push(
          `Bucket '${bucket}': ${n} samples < ${SMALL_BUCKET_WARN_THRESHOLD} — calibration metrics are not statistically significant`,
        );
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      sampleSize,
      excludedNoPrediction: 0,
      excludedNoOutcome: 0,
      meanAbsoluteErrorEur: mean(absErrors),
      medianAbsoluteErrorEur: median(absErrors),
      biasEur,
      biasPct,
      buyMaxMeanAbsoluteErrorEur: mean(buyMaxAbsErrors),
      buyMaxHitRate: buyMaxHits.length / sampleSize,
      calibration: calibration as Record<'low' | 'mid' | 'high', CalibrationBucketStat>,
      warnings,
    };
  }

  /** Expose the signals list for the weight suggester (ADR-0009). */
  async signals(): Promise<BacktestSignal[]> {
    return await this.backtestRepo.findAll();
  }

  private async writeSignalForOutcome(outcome: Outcome): Promise<boolean> {
    const outcomeId = outcome.id;
    const salePriceEur = outcome.salePriceEur;
    if (outcomeId === undefined || salePriceEur === undefined) return false;

    // All three operations (SELECT candidates, SELECT scoring_runs, UPSERT backtest_signals)
    // execute atomically inside a single DB transaction. Without this, a concurrent pipeline
    // run between the SELECT and UPSERT could mutate scoring data, producing inconsistent
    // backtest signals. SQLite uses SERIALIZABLE isolation by default within a transaction.
    return await this.db.transaction(async (txDb) => {
      const snapshot = await this.findSnapshotForOutcome(outcome.domain, outcome.occurredAt, txDb);
      if (snapshot === null) return false;

      const costs = await this.#computeDomainCosts(outcome.domain, outcome.occurredAt);

      await this.backtestRepo.upsert({
        domain: outcome.domain,
        outcomeId,
        scoringRunId: snapshot.run_id,
        predictedExpectedValue: snapshot.expected_value,
        predictedBuyMax: snapshot.suggested_buy_max,
        predictedListPrice: snapshot.suggested_list_price,
        predictedConfidence: snapshot.confidence,
        actualSalePriceEur: salePriceEur,
        acquisitionCostEur: costs.acquisitionCostEur,
        totalRenewalCostPaidEur: costs.totalRenewalCostPaidEur,
      });
      return true;
    });
  }

  async #computeDomainCosts(
    domain: string,
    occurredAt: string,
    txDb?: DatabaseProvider,
  ): Promise<DomainCostInfo> {
    const db = txDb ?? this.db;
    try {
      const row = await db.queryOne<{
        acquisition_cost: number;
        renewal_cost: number;
        acquired_at: string;
      }>(
        'SELECT acquisition_cost, renewal_cost, acquired_at FROM portfolio_entries WHERE domain = ? AND tenant_id = ?',
        [domain, resolveTenantId()],
      );

      if (!row) {
        return { acquisitionCostEur: 0, totalRenewalCostPaidEur: 0 };
      }

      const acquiredAt = new Date(row.acquired_at).getTime();
      const soldAt = new Date(occurredAt).getTime();
      const daysHeld = Math.max(1, Math.floor((soldAt - acquiredAt) / 86_400_000));
      const yearsHeld = Math.max(1, Math.ceil(daysHeld / 365));
      const totalRenewalsPaid = Math.max(0, yearsHeld - 1);

      return {
        acquisitionCostEur: row.acquisition_cost,
        totalRenewalCostPaidEur: totalRenewalsPaid * row.renewal_cost,
      };
    } catch {
      return { acquisitionCostEur: 0, totalRenewalCostPaidEur: 0 };
    }
  }

  /**
   * Find the last scoring_runs row for `domain` whose `scored_at` is
   * not later than `occurredAt`. Joins through `candidates` because
   * `scoring_runs.candidate_id` is the only stable link to a domain.
   */
  private async findSnapshotForOutcome(
    domain: string,
    occurredAt: string,
    txDb?: DatabaseProvider,
  ): Promise<ScoringSnapshotRow | null> {
    const db = txDb ?? this.db;
    const candidate = await db.queryOne<{ id: number }>(
      'SELECT id FROM candidates WHERE domain = ? AND tenant_id = ?',
      [domain, resolveTenantId()],
    );
    if (candidate === undefined || candidate === null) return null;

    const row = await db.queryOne<ScoringSnapshotRow>(
      `SELECT sr.id, sr.run_id, sr.expected_value, sr.confidence, sr.suggested_buy_max,
              sr.suggested_list_price, sr.weighted_score, sr.recommended, sr.scored_at
         FROM scoring_runs sr
         JOIN candidates c ON c.id = sr.candidate_id
        WHERE sr.candidate_id = ?
          AND sr.scored_at <= ?
          AND c.tenant_id = ?
        ORDER BY sr.scored_at DESC, sr.id DESC
        LIMIT 1`,
      [candidate.id, occurredAt, resolveTenantId()],
    );
    return row ?? null;
  }
}
