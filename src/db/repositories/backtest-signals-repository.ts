import type Database from 'better-sqlite3';

export type ConfidenceBucket = 'low' | 'mid' | 'high';

export const CONFIDENCE_BUCKETS: readonly ConfidenceBucket[] = ['low', 'mid', 'high'] as const;

export function isConfidenceBucket(value: string): value is ConfidenceBucket {
  return (CONFIDENCE_BUCKETS as readonly string[]).includes(value);
}

export function bucketForConfidence(confidence: number): ConfidenceBucket {
  if (confidence < 0.3) return 'low';
  if (confidence < 0.6) return 'mid';
  return 'high';
}

export interface BacktestSignal {
  id?: number;
  domain: string;
  outcomeId: number;
  scoringRunId: string;
  predictedExpectedValue: number;
  predictedBuyMax: number;
  predictedListPrice: number;
  predictedConfidence: number;
  actualSalePriceEur: number;
  absoluteErrorEur: number;
  signedErrorEur: number;
  confidenceBucket: ConfidenceBucket;
  recordedAt?: string;
}

interface BacktestRow {
  id: number;
  domain: string;
  outcome_id: number;
  scoring_run_id: string;
  predicted_expected_value: number;
  predicted_buy_max: number;
  predicted_list_price: number;
  predicted_confidence: number;
  actual_sale_price_eur: number;
  absolute_error_eur: number;
  signed_error_eur: number;
  confidence_bucket: string;
  recorded_at: string;
}

function rowToSignal(row: BacktestRow): BacktestSignal {
  const bucket: ConfidenceBucket = isConfidenceBucket(row.confidence_bucket)
    ? row.confidence_bucket
    : 'low';
  return {
    id: row.id,
    domain: row.domain,
    outcomeId: row.outcome_id,
    scoringRunId: row.scoring_run_id,
    predictedExpectedValue: row.predicted_expected_value,
    predictedBuyMax: row.predicted_buy_max,
    predictedListPrice: row.predicted_list_price,
    predictedConfidence: row.predicted_confidence,
    actualSalePriceEur: row.actual_sale_price_eur,
    absoluteErrorEur: row.absolute_error_eur,
    signedErrorEur: row.signed_error_eur,
    confidenceBucket: bucket,
    recordedAt: row.recorded_at,
  };
}

export interface InsertBacktestSignalInput {
  domain: string;
  outcomeId: number;
  scoringRunId: string;
  predictedExpectedValue: number;
  predictedBuyMax: number;
  predictedListPrice: number;
  predictedConfidence: number;
  actualSalePriceEur: number;
}

/**
 * CRUD over the `backtest_signals` table.
 *
 * `upsert()` is the workhorse: the UNIQUE(outcome_id, scoring_run_id)
 * index makes repeated runs of the backtest idempotent. `findAll()` is
 * read-only and powers the report (see ADR-0008).
 */
export class BacktestSignalsRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new signal. Computes derived columns (`absolute_error_eur`,
   * `signed_error_eur`, `confidence_bucket`) from the input so callers
   * never have to think about them.
   *
   * If a row with the same (outcome_id, scoring_run_id) already exists
   * (idempotent rebuild), it is overwritten with the latest values. This
   * is safe: the table is an immutable audit log and rebuild = refresh.
   */
  upsert(input: InsertBacktestSignalInput): BacktestSignal {
    const absErr = Math.abs(input.predictedExpectedValue - input.actualSalePriceEur);
    const signedErr = input.actualSalePriceEur - input.predictedExpectedValue;
    const bucket = bucketForConfidence(input.predictedConfidence);

    const row = this.db
      .prepare(
        `INSERT INTO backtest_signals
           (domain, outcome_id, scoring_run_id, predicted_expected_value,
            predicted_buy_max, predicted_list_price, predicted_confidence,
            actual_sale_price_eur, absolute_error_eur, signed_error_eur,
            confidence_bucket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(outcome_id, scoring_run_id) DO UPDATE SET
           domain                    = excluded.domain,
           predicted_expected_value  = excluded.predicted_expected_value,
           predicted_buy_max         = excluded.predicted_buy_max,
           predicted_list_price      = excluded.predicted_list_price,
           predicted_confidence      = excluded.predicted_confidence,
           actual_sale_price_eur     = excluded.actual_sale_price_eur,
           absolute_error_eur        = excluded.absolute_error_eur,
           signed_error_eur          = excluded.signed_error_eur,
           confidence_bucket         = excluded.confidence_bucket,
           recorded_at               = datetime('now')
         RETURNING id`,
      )
      .get(
        input.domain,
        input.outcomeId,
        input.scoringRunId,
        input.predictedExpectedValue,
        input.predictedBuyMax,
        input.predictedListPrice,
        input.predictedConfidence,
        input.actualSalePriceEur,
        absErr,
        signedErr,
        bucket,
      ) as { id: number };

    const stored = this.db
      .prepare('SELECT * FROM backtest_signals WHERE id = ?')
      .get(row.id) as BacktestRow;
    return rowToSignal(stored);
  }

  findByOutcome(outcomeId: number): BacktestSignal[] {
    const rows = this.db
      .prepare('SELECT * FROM backtest_signals WHERE outcome_id = ? ORDER BY recorded_at DESC')
      .all(outcomeId) as BacktestRow[];
    return rows.map(rowToSignal);
  }

  findByDomain(domain: string): BacktestSignal[] {
    const rows = this.db
      .prepare('SELECT * FROM backtest_signals WHERE domain = ? ORDER BY recorded_at DESC')
      .all(domain) as BacktestRow[];
    return rows.map(rowToSignal);
  }

  findAll(): BacktestSignal[] {
    const rows = this.db
      .prepare('SELECT * FROM backtest_signals ORDER BY recorded_at DESC, id DESC')
      .all() as BacktestRow[];
    return rows.map(rowToSignal);
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM backtest_signals')
      .get() as { n: number };
    return row.n;
  }

  deleteAll(): void {
    this.db.prepare('DELETE FROM backtest_signals').run();
  }
}
