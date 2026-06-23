import type Database from 'better-sqlite3';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
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
    private readonly db: Database.Database,
    private readonly outcomeRepo: OutcomeRepository,
  ) {}

  async refresh(): Promise<AccuracyReportSnapshot> {
    const outcomes = await this.outcomeRepo.findAll();
    let included = 0;
    let skippedNoScore = 0;
    let skippedNoOutcome = 0;

    for (const outcome of outcomes) {
      const domain = outcome.domain;
      const scoringRun = this.findScoringRunBefore(domain, outcome.occurredAt);
      if (scoringRun === null) {
        skippedNoScore++;
        continue;
      }
      const candidate = this.db
        .prepare('SELECT id, domain, tld FROM candidates WHERE domain = ?')
        .get(domain) as { id: number; domain: string; tld: string } | undefined;

      if (!candidate) {
        skippedNoOutcome++;
        continue;
      }

      const commercialScore = scoringRun.commercial_score;
      const marketScore = scoringRun.market_score;
      const expiryScore = scoringRun.expiry_score;

      this.#upsertOutcomeScore({
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
        commercialScore,
        marketScore,
        expiryScore,
      });
      included++;
    }

    return { scanned: outcomes.length, included, skippedNoScore, skippedNoOutcome };
  }

  generate(): AccuracyReport {
    const scores = this.#findAllOutcomeScores();
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
    const soldWithPrice = sold.filter((s) => s.actualSalePrice !== null && s.actualSalePrice > 0);

    const overall = this.#computeOverallMetrics(soldWithPrice);

    const confusionMatrix = this.#computeConfusionMatrix(sold, dropped, expired);

    const byTld = this.#computePerTld(soldWithPrice, warnings);

    const calibration = this.#computeCalibration(soldWithPrice, warnings);

    const bySignalAvailability = this.#computeSignalAvailability(soldWithPrice);

    const trend = this.#computeTrend(soldWithPrice);

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

  #computeOverallMetrics(soldWithPrice: OutcomeAccuracyScore[]): AccuracyMetrics {
    if (soldWithPrice.length === 0) return zeroMetrics();

    const errors = soldWithPrice.map((s) => s.expectedValue - (s.actualSalePrice ?? 0));
    const predicted = soldWithPrice.map((s) => s.expectedValue);
    const actual = soldWithPrice.map((s) => s.actualSalePrice ?? 0);

    return computeMetrics(errors, predicted, actual);
  }

  #computeConfusionMatrix(
    sold: OutcomeAccuracyScore[],
    dropped: OutcomeAccuracyScore[],
    expired: OutcomeAccuracyScore[],
  ): ConfusionMatrix {
    const truePositives = sold.filter((s) => s.recommended).length;
    const falseNegatives = sold.filter((s) => !s.recommended).length;

    const falsePositives = [...dropped, ...expired].filter((s) => s.recommended).length;
    const trueNegatives = [...dropped, ...expired].filter((s) => !s.recommended).length;

    const precision =
      truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
    const recall =
      truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
    const f1 = precision + recall > 0 ? (2 * (precision * recall)) / (precision + recall) : 0;

    return { truePositives, falsePositives, trueNegatives, falseNegatives, precision, recall, f1 };
  }

  #computePerTld(soldWithPrice: OutcomeAccuracyScore[], warnings: string[]): TldAccuracy[] {
    const byTld = new Map<string, { predicted: number[]; actual: number[] }>();

    for (const s of soldWithPrice) {
      if (!byTld.has(s.tld)) {
        byTld.set(s.tld, { predicted: [], actual: [] });
      }
      const bucket = byTld.get(s.tld)!;
      bucket.predicted.push(s.expectedValue);
      bucket.actual.push(s.actualSalePrice ?? 0);
    }

    const result: TldAccuracy[] = [];
    for (const [tld, data] of byTld) {
      const errors = data.predicted.map((p, i) => p - (data.actual[i] ?? 0));
      const metrics = computeMetrics(errors, data.predicted, data.actual);
      if (data.predicted.length < SMALL_BUCKET_WARN_THRESHOLD) {
        warnings.push(
          `TLD '${tld}': ${data.predicted.length} samples < ${SMALL_BUCKET_WARN_THRESHOLD} — accuracy metrics not statistically significant`,
        );
      }
      result.push({
        tld,
        sampleSize: data.predicted.length,
        mape: metrics.mape,
        bias: metrics.bias,
        meanPredicted: mean(data.predicted),
        meanActual: mean(data.actual),
      });
    }

    result.sort((a, b) => b.sampleSize - a.sampleSize);
    return result;
  }

  #computeCalibration(
    soldWithPrice: OutcomeAccuracyScore[],
    warnings: string[],
  ): Record<string, CalibrationBucketStat> {
    const calibration: Record<string, CalibrationBucketStat> = {};
    for (const bucket of CONFIDENCE_BUCKETS) {
      const subset = soldWithPrice.filter((s) => bucketForConfidence(s.confidence) === bucket);
      const n = subset.length;
      calibration[bucket] = {
        n,
        meanAbsError:
          n > 0 ? mean(subset.map((s) => Math.abs(s.expectedValue - (s.actualSalePrice ?? 0)))) : 0,
        meanRealised: n > 0 ? mean(subset.map((s) => s.actualSalePrice ?? 0)) : 0,
        meanPredicted: n > 0 ? mean(subset.map((s) => s.expectedValue)) : 0,
      };
      if (n > 0 && n < SMALL_BUCKET_WARN_THRESHOLD) {
        warnings.push(
          `Confidence bucket '${bucket}': ${n} samples < ${SMALL_BUCKET_WARN_THRESHOLD} — calibration metrics not statistically significant`,
        );
      }
    }
    return calibration;
  }

  #computeSignalAvailability(soldWithPrice: OutcomeAccuracyScore[]): SignalAvailabilityAccuracy[] {
    const signals: Array<{ signal: string; key: keyof OutcomeAccuracyScore }> = [
      { signal: 'commercial', key: 'commercialScore' },
      { signal: 'market', key: 'marketScore' },
      { signal: 'expiry', key: 'expiryScore' },
    ];

    return signals.map(({ signal, key }) => {
      const available = soldWithPrice.filter((s) => (s[key] as number) > 0);
      const unavailable = soldWithPrice.filter((s) => (s[key] as number) === 0);

      const availableMetrics =
        available.length > 0
          ? computeMetrics(
              available.map((s) => s.expectedValue - (s.actualSalePrice ?? 0)),
              available.map((s) => s.expectedValue),
              available.map((s) => s.actualSalePrice ?? 0),
            )
          : zeroMetrics();

      const unavailableMetrics =
        unavailable.length > 0
          ? computeMetrics(
              unavailable.map((s) => s.expectedValue - (s.actualSalePrice ?? 0)),
              unavailable.map((s) => s.expectedValue),
              unavailable.map((s) => s.actualSalePrice ?? 0),
            )
          : zeroMetrics();

      return { signal, available: availableMetrics, unavailable: unavailableMetrics };
    });
  }

  #computeTrend(soldWithPrice: OutcomeAccuracyScore[]): AccuracyTrend[] {
    if (soldWithPrice.length === 0) return [];

    const byPeriod = new Map<string, OutcomeAccuracyScore[]>();

    for (const s of soldWithPrice) {
      const d = new Date(s.occurredAt);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byPeriod.has(period)) {
        byPeriod.set(period, []);
      }
      byPeriod.get(period)!.push(s);
    }

    const sortedPeriods = [...byPeriod.keys()].sort();
    const result: AccuracyTrend[] = [];

    for (const period of sortedPeriods) {
      const subset = byPeriod.get(period)!;
      const errors = subset.map((s) => s.expectedValue - (s.actualSalePrice ?? 0));
      const predicted = subset.map((s) => s.expectedValue);
      const actual = subset.map((s) => s.actualSalePrice ?? 0);

      const metrics = computeMetrics(errors, predicted, actual);

      const tp = subset.filter((s) => s.recommended).length;
      const fn = subset.filter((s) => !s.recommended).length;
      const f1 = tp + fn > 0 ? (2 * tp) / (2 * tp + fn) : 0;

      result.push({
        period,
        sampleSize: subset.length,
        mape: metrics.mape,
        f1,
      });
    }

    return result;
  }

  findScoringRunBefore(
    domain: string,
    before: string,
  ): {
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
  } | null {
    const candidate = this.db
      .prepare('SELECT id, domain, tld FROM candidates WHERE domain = ?')
      .get(domain) as { id: number; domain: string; tld: string } | undefined;
    if (!candidate) return null;

    const row = this.db
      .prepare(
        `SELECT id, run_id, candidate_id, expected_value, confidence,
                suggested_buy_max, suggested_list_price,
                weighted_score, recommended,
                commercial_score, market_score, expiry_score,
                scored_at
           FROM scoring_runs
          WHERE candidate_id = ?
            AND scored_at <= ?
          ORDER BY scored_at DESC, id DESC
          LIMIT 1`,
      )
      .get(candidate.id, before) as
      | {
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
        }
      | undefined;

    return row ?? null;
  }

  #upsertOutcomeScore(score: OutcomeAccuracyScore): void {
    this.db
      .prepare(
        `INSERT INTO outcome_scores
           (domain, outcome_type, recommended, weighted_score, confidence,
            expected_value, actual_sale_price, tld, scored_at, occurred_at,
            commercial_score, market_score, expiry_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      )
      .run(
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
      );
  }

  #findAllOutcomeScores(): OutcomeAccuracyScore[] {
    const rows = this.db
      .prepare(
        `SELECT domain, outcome_type, recommended, weighted_score, confidence,
                expected_value, actual_sale_price, tld, scored_at, occurred_at,
                commercial_score, market_score, expiry_score
           FROM outcome_scores
          ORDER BY occurred_at DESC`,
      )
      .all() as Array<{
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
    }>;

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
