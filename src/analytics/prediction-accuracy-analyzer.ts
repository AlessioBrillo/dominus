import type { DatabaseProvider } from '../db/provider/interface.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import { resolveTenantId } from '../utils/tenant-context.js';
import type {
  AccuracyReport,
  AccuracyMetrics,
  ConfusionMatrix,
  TldAccuracy,
  AccuracyTrend,
  SignalAvailabilityAccuracy,
  CalibrationBucketStat,
  OutcomeAccuracyScore,
  AccuracyReportSnapshot,
} from './types.js';
import { bucketForConfidence, CONFIDENCE_BUCKETS } from './types.js';

const SMALL_BUCKET_WARN_THRESHOLD = 10;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function rootMeanSquare(values: number[]): number {
  if (values.length === 0) return 0;
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  return Math.sqrt(sumSq / values.length);
}

function zeroMetrics(): AccuracyMetrics {
  return { mape: 0, medianApe: 0, mae: 0, rmse: 0, bias: 0, biasPct: 0, sampleSize: 0 };
}

function computeMetrics(errors: number[], predicted: number[], actual: number[]): AccuracyMetrics {
  const n = errors.length;
  if (n === 0) return zeroMetrics();

  const absPctErrors = errors.map((e, i) => {
    const a = actual[i] ?? 0;
    return a !== 0 ? (Math.abs(e) / Math.max(Math.abs(a), 0.01)) * 100 : 0;
  });

  const mape = mean(absPctErrors);
  const medianApe = median(absPctErrors);
  const mae = mean(errors.map(Math.abs));
  const rmse = rootMeanSquare(errors);
  const bias = mean(predicted.map((p, i) => p - (actual[i] ?? 0)));
  const meanActual = mean(actual);
  const biasPct = meanActual !== 0 ? (bias / meanActual) * 100 : 0;

  return { mape, medianApe, mae, rmse, bias, biasPct, sampleSize: n };
}

export class PredictionAccuracyAnalyzer {
  constructor(
    private readonly db: DatabaseProvider,
    private readonly outcomeRepo: OutcomeRepository,
  ) {}

  async refresh(): Promise<AccuracyReportSnapshot> {
    const outcomes = await this.outcomeRepo.findAll();
    let included = 0;
    let skippedNoScore = 0;
    let skippedNoOutcome = 0;

    for (const outcome of outcomes) {
      const domain = outcome.domain;
      const scoringRun = await this.findScoringRunBefore(domain, outcome.occurredAt);
      if (scoringRun === null) {
        skippedNoScore++;
        continue;
      }
      const candidate = await this.db.queryOne<{ id: number; domain: string; tld: string }>(
        'SELECT id, domain, tld FROM candidates WHERE domain = ? AND tenant_id = ?',
        [domain, resolveTenantId()],
      );

      if (!candidate) {
        skippedNoOutcome++;
        continue;
      }

      await this.#upsertOutcomeScore({
        domain,
        outcomeType: outcome.type,
        recommended: scoringRun.recommended === 1,
        weightedScore: scoringRun.weighted_score,
        confidence: scoringRun.confidence,
        expectedValue: scoringRun.expected_value,
        actualSalePrice: outcome.salePriceEur ?? null,
        tld: candidate.tld,
        scoredAt: scoringRun.scored_at,
        occurredAt: outcome.occurredAt,
        commercialScore: scoringRun.commercial_score,
        marketScore: scoringRun.market_score,
        expiryScore: scoringRun.expiry_score,
      });
      included++;
    }

    return { scanned: outcomes.length, included, skippedNoScore, skippedNoOutcome };
  }

  async generate(): Promise<AccuracyReport> {
    const scores = await this.#findAllOutcomeScores();
    const sampleSize = scores.length;

    if (sampleSize === 0) {
      return {
        generatedAt: new Date().toISOString(),
        sampleSize: 0,
        overall: zeroMetrics(),
        confusionMatrix: {
          truePositives: 0,
          falsePositives: 0,
          trueNegatives: 0,
          falseNegatives: 0,
          precision: 0,
          recall: 0,
          f1: 0,
        },
        byTld: [],
        calibration: {
          low: { n: 0, meanAbsError: 0, meanRealised: 0, meanPredicted: 0 },
          mid: { n: 0, meanAbsError: 0, meanRealised: 0, meanPredicted: 0 },
          high: { n: 0, meanAbsError: 0, meanRealised: 0, meanPredicted: 0 },
        },
        bySignalAvailability: [],
        trend: [],
        warnings: ['No outcome scores recorded. Run refresh() first or record some outcomes.'],
      };
    }

    const warnings: string[] = [];

    const { sold, dropped, expired } = this.#partitionOutcomes(scores);

    const overall = this.#computeOverallMetrics(sold);

    const confusionMatrix = this.#computeConfusionMatrix(sold, dropped, expired);

    const byTld = this.#computePerTld(sold, warnings);

    const calibration = this.#computeCalibration(sold, warnings);

    const bySignalAvailability = this.#computeSignalAvailability(sold);

    const trend = this.#computeTrend(sold);

    return {
      generatedAt: new Date().toISOString(),
      sampleSize,
      overall,
      confusionMatrix,
      byTld,
      calibration,
      bySignalAvailability,
      trend,
      warnings,
    };
  }

  #partitionOutcomes(scores: OutcomeAccuracyScore[]): {
    sold: OutcomeAccuracyScore[];
    dropped: OutcomeAccuracyScore[];
    expired: OutcomeAccuracyScore[];
  } {
    const sold: OutcomeAccuracyScore[] = [];
    const dropped: OutcomeAccuracyScore[] = [];
    const expired: OutcomeAccuracyScore[] = [];

    for (const s of scores) {
      switch (s.outcomeType) {
        case 'sold':
          sold.push(s);
          break;
        case 'dropped':
          dropped.push(s);
          break;
        case 'expired':
          expired.push(s);
          break;
      }
    }

    return { sold, dropped, expired };
  }

  #computeOverallMetrics(sold: OutcomeAccuracyScore[]): AccuracyMetrics {
    const predicted = sold.map((s) => s.expectedValue);
    const actual = sold.map((s) => s.actualSalePrice as number);
    const errors = predicted.map((p, i) => p - actual[i]!);
    return computeMetrics(errors, predicted, actual);
  }

  #computeConfusionMatrix(
    sold: OutcomeAccuracyScore[],
    dropped: OutcomeAccuracyScore[],
    expired: OutcomeAccuracyScore[],
  ): ConfusionMatrix {
    const recEvents = [...sold, ...dropped, ...expired];

    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn_ = 0;

    for (const ev of recEvents) {
      if (ev.outcomeType === 'sold' && ev.recommended) tp++;
      else if (ev.outcomeType === 'sold' && !ev.recommended) fn_++;
      else if (ev.outcomeType !== 'sold' && !ev.recommended) tn++;
      else fp++;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn_ > 0 ? tp / (tp + fn_) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return {
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn_,
      precision: Math.round(precision * 100) / 100,
      recall: Math.round(recall * 100) / 100,
      f1: Math.round(f1 * 100) / 100,
    };
  }

  #computePerTld(sold: OutcomeAccuracyScore[], warnings: string[]): TldAccuracy[] {
    const byTld = new Map<string, { predicted: number[]; actual: number[] }>();

    for (const s of sold) {
      const tld = s.tld;
      if (!byTld.has(tld)) byTld.set(tld, { predicted: [], actual: [] });
      const bucket = byTld.get(tld)!;
      bucket.predicted.push(s.expectedValue);
      bucket.actual.push(s.actualSalePrice as number);
    }

    const tlds: TldAccuracy[] = [];
    for (const [tld, data] of byTld.entries()) {
      const errors = data.predicted.map((p, i) => p - data.actual[i]!);
      const mape =
        errors.length > 0
          ? mean(
              errors.map((e, i) =>
                data.actual[i]! !== 0
                  ? (Math.abs(e) / Math.max(Math.abs(data.actual[i]!), 0.01)) * 100
                  : 0,
              ),
            )
          : 0;
      const bias =
        data.predicted.length > 0 ? mean(data.predicted.map((p, i) => p - data.actual[i]!)) : 0;
      tlds.push({
        tld,
        sampleSize: data.predicted.length,
        mape,
        bias,
        meanPredicted: mean(data.predicted),
        meanActual: mean(data.actual),
      });
      if (data.predicted.length < SMALL_BUCKET_WARN_THRESHOLD) {
        warnings.push(
          `TLD '${tld}': ${data.predicted.length} samples < ${SMALL_BUCKET_WARN_THRESHOLD} — accuracy metrics may not be reliable`,
        );
      }
    }

    tlds.sort((a, b) => b.sampleSize - a.sampleSize);
    return tlds;
  }

  #computeCalibration(
    sold: OutcomeAccuracyScore[],
    warnings: string[],
  ): Record<string, CalibrationBucketStat> {
    const calibration: Record<string, { errors: number[]; predicted: number[]; actual: number[] }> =
      {};
    for (const bucket of CONFIDENCE_BUCKETS) {
      calibration[bucket] = { errors: [], predicted: [], actual: [] };
    }

    for (const s of sold) {
      const bucket = bucketForConfidence(s.confidence);
      calibration[bucket]!.predicted.push(s.expectedValue);
      calibration[bucket]!.actual.push(s.actualSalePrice as number);
      calibration[bucket]!.errors.push(s.expectedValue - (s.actualSalePrice as number));
    }

    const result: Record<string, CalibrationBucketStat> = {};
    for (const bucket of CONFIDENCE_BUCKETS) {
      const data = calibration[bucket]!;
      const n = data.errors.length;
      result[bucket] = {
        n,
        meanAbsError: mean(data.errors.map(Math.abs)),
        meanRealised: mean(data.actual),
        meanPredicted: mean(data.predicted),
      };
      if (n > 0 && n < SMALL_BUCKET_WARN_THRESHOLD) {
        warnings.push(
          `Calibration bucket '${bucket}': ${n} samples < ${SMALL_BUCKET_WARN_THRESHOLD} — calibration may not be reliable`,
        );
      }
    }

    return result;
  }

  #computeSignalAvailability(sold: OutcomeAccuracyScore[]): SignalAvailabilityAccuracy[] {
    const highCommercial: AccuracyMetrics[] = [];
    const lowCommercial: AccuracyMetrics[] = [];

    for (const s of sold) {
      const error = s.expectedValue - (s.actualSalePrice as number);
      const predicted = s.expectedValue;
      const actual = s.actualSalePrice as number;
      const metrics = computeMetrics([error], [predicted], [actual]);
      if (s.commercialScore > 0) {
        highCommercial.push(metrics);
      } else {
        lowCommercial.push(metrics);
      }
    }

    const result: SignalAvailabilityAccuracy[] = [];

    if (highCommercial.length > 0) {
      result.push({
        signal: 'commercial',
        available: aggregateMetrics(highCommercial),
        unavailable: lowCommercial.length > 0 ? aggregateMetrics(lowCommercial) : zeroMetrics(),
      });
    }

    return result;
  }

  #computeTrend(sold: OutcomeAccuracyScore[]): AccuracyTrend[] {
    const byMonth = new Map<string, { errors: number[]; predicted: number[]; actual: number[] }>();

    for (const s of sold) {
      const month = s.occurredAt.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, { errors: [], predicted: [], actual: [] });
      const bucket = byMonth.get(month)!;
      bucket.predicted.push(s.expectedValue);
      bucket.actual.push(s.actualSalePrice as number);
      bucket.errors.push(s.expectedValue - (s.actualSalePrice as number));
    }

    return Array.from(byMonth.entries())
      .map(([period, data]) => ({
        period,
        mape: mean(
          data.errors.map((e, i) =>
            data.actual[i]! !== 0
              ? (Math.abs(e) / Math.max(Math.abs(data.actual[i]!), 0.01)) * 100
              : 0,
          ),
        ),
        sampleSize: data.errors.length,
        f1: 0,
      }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  private async findScoringRunBefore(
    domain: string,
    before: string,
  ): Promise<{
    id: number;
    run_id: string;
    candidate_id: number;
    expected_value: number;
    confidence: number;
    suggested_buy_max: number;
    suggested_list_price: number;
    weighted_score: number;
    recommended: number;
    commercial_score: number;
    market_score: number;
    expiry_score: number;
    scored_at: string;
  } | null> {
    const candidate = await this.db.queryOne<{ id: number }>(
      'SELECT id FROM candidates WHERE domain = ? AND tenant_id = ?',
      [domain, resolveTenantId()],
    );
    if (candidate === null) return null;

    const row = await this.db.queryOne<{
      id: number;
      run_id: string;
      candidate_id: number;
      expected_value: number;
      confidence: number;
      suggested_buy_max: number;
      suggested_list_price: number;
      weighted_score: number;
      recommended: number;
      commercial_score: number;
      market_score: number;
      expiry_score: number;
      scored_at: string;
    }>(
      `SELECT sr.id, sr.run_id, sr.candidate_id, sr.expected_value, sr.confidence, sr.suggested_buy_max,
              sr.suggested_list_price, sr.weighted_score, sr.recommended, sr.commercial_score,
              sr.market_score, sr.expiry_score, sr.scored_at
         FROM scoring_runs sr
         JOIN candidates c ON c.id = sr.candidate_id
        WHERE sr.candidate_id = ? AND sr.scored_at <= ? AND c.tenant_id = ?
        ORDER BY sr.scored_at DESC, sr.id DESC
        LIMIT 1`,
      [candidate.id, before, resolveTenantId()],
    );

    return row ?? null;
  }

  async #upsertOutcomeScore(score: OutcomeAccuracyScore): Promise<void> {
    const tid = resolveTenantId();
    await this.db.exec(
      `INSERT INTO outcome_scores
         (domain, outcome_type, recommended, weighted_score, confidence,
          expected_value, actual_sale_price, tld, scored_at, occurred_at,
          commercial_score, market_score, expiry_score, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, occurred_at) DO UPDATE SET
         recommended          = excluded.recommended,
         weighted_score       = excluded.weighted_score,
         confidence           = excluded.confidence,
         expected_value       = excluded.expected_value,
         actual_sale_price    = excluded.actual_sale_price,
         tld                  = excluded.tld,
         scored_at            = excluded.scored_at,
         commercial_score     = excluded.commercial_score,
         market_score         = excluded.market_score,
         expiry_score         = excluded.expiry_score`,
      [
        score.domain,
        score.outcomeType,
        score.recommended ? 1 : 0,
        score.weightedScore,
        score.confidence,
        score.expectedValue,
        score.actualSalePrice,
        score.tld,
        score.scoredAt,
        score.occurredAt,
        score.commercialScore,
        score.marketScore,
        score.expiryScore,
        tid,
      ],
    );
  }

  async #findAllOutcomeScores(): Promise<OutcomeAccuracyScore[]> {
    const rows = await this.db.query<{
      domain: string;
      outcome_type: string;
      recommended: number;
      weighted_score: number;
      confidence: number;
      expected_value: number;
      actual_sale_price: number | null;
      tld: string;
      scored_at: string;
      occurred_at: string;
      commercial_score: number;
      market_score: number;
      expiry_score: number;
    }>(
      `SELECT domain, outcome_type, recommended, weighted_score, confidence,
              expected_value, actual_sale_price, tld, scored_at, occurred_at,
              commercial_score, market_score, expiry_score
         FROM outcome_scores
        WHERE tenant_id = ?
        ORDER BY occurred_at DESC`,
      [resolveTenantId()],
    );

    return rows.map((r) => ({
      domain: r.domain,
      outcomeType: r.outcome_type,
      recommended: r.recommended === 1,
      weightedScore: r.weighted_score,
      confidence: r.confidence,
      expectedValue: r.expected_value,
      actualSalePrice: r.actual_sale_price,
      tld: r.tld,
      scoredAt: r.scored_at,
      occurredAt: r.occurred_at,
      commercialScore: r.commercial_score,
      marketScore: r.market_score,
      expiryScore: r.expiry_score,
    }));
  }
}

function aggregateMetrics(metrics: AccuracyMetrics[]): AccuracyMetrics {
  if (metrics.length === 0) return zeroMetrics();
  const n = metrics.reduce((sum, m) => sum + m.sampleSize, 0);
  return {
    mape: mean(metrics.map((m) => m.mape)),
    medianApe: mean(metrics.map((m) => m.medianApe)),
    mae: mean(metrics.map((m) => m.mae)),
    rmse: Math.sqrt(mean(metrics.map((m) => m.rmse * m.rmse))),
    bias: mean(metrics.map((m) => m.bias)),
    biasPct: mean(metrics.map((m) => m.biasPct)),
    sampleSize: n,
  };
}
