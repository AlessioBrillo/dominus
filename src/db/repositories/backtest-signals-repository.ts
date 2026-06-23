import type { DatabaseProvider } from '../provider/interface.js';

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
  acquisitionCostEur: number;
  totalRenewalCostPaidEur: number;
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
  acquisition_cost_eur: number;
  total_renewal_cost_paid_eur: number;
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
    acquisitionCostEur: row.acquisition_cost_eur,
    totalRenewalCostPaidEur: row.total_renewal_cost_paid_eur,
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
  acquisitionCostEur?: number;
  totalRenewalCostPaidEur?: number;
}

/**
 * CRUD over the `backtest_signals` table.
 *
 * `upsert()` is the workhorse: the UNIQUE(outcome_id, scoring_run_id)
 * index makes repeated runs of the backtest idempotent. `findAll()` is
 * read-only and powers the report (see ADR-0008).
 */
export class BacktestSignalsRepository {
  constructor(private readonly db: DatabaseProvider) {}

  /**
   * Insert a new signal. Computes derived columns (`absolute_error_eur`,
   * `signed_error_eur`, `confidence_bucket`) from the input so callers
   * never have to think about them.
   *
   * If a row with the same (outcome_id, scoring_run_id) already exists
   * (idempotent rebuild), it is overwritten with the latest values. This
   * is safe: the table is an immutable audit log and rebuild = refresh.
   */
  async upsert(input: InsertBacktestSignalInput): Promise<BacktestSignal> {
    const absErr = Math.abs(input.predictedExpectedValue - input.actualSalePriceEur);
    const signedErr = input.actualSalePriceEur - input.predictedExpectedValue;
    const bucket = bucketForConfidence(input.predictedConfidence);

    const row = (await this.db.queryOne<{ id: number }>(
      `INSERT INTO backtest_signals
         (domain, outcome_id, scoring_run_id, predicted_expected_value,
          predicted_buy_max, predicted_list_price, predicted_confidence,
          actual_sale_price_eur, absolute_error_eur, signed_error_eur,
          confidence_bucket, acquisition_cost_eur, total_renewal_cost_paid_eur)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         acquisition_cost_eur      = excluded.acquisition_cost_eur,
         total_renewal_cost_paid_eur = excluded.total_renewal_cost_paid_eur,
         recorded_at               = datetime('now')
       RETURNING id`,
      [
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
        input.acquisitionCostEur ?? 0,
        input.totalRenewalCostPaidEur ?? 0,
      ],
    ))!;

    const stored = (await this.db.queryOne<BacktestRow>('SELECT * FROM backtest_signals WHERE id = ?', [
      row.id,
    ]))!;
    return rowToSignal(stored);
  }

  async findByOutcome(outcomeId: number): Promise<BacktestSignal[]> {
    const rows = await this.db.query<BacktestRow>(
      'SELECT * FROM backtest_signals WHERE outcome_id = ? ORDER BY recorded_at DESC',
      [outcomeId],
    );
    return rows.map(rowToSignal);
  }

  async findByDomain(domain: string): Promise<BacktestSignal[]> {
    const rows = await this.db.query<BacktestRow>(
      'SELECT * FROM backtest_signals WHERE domain = ? ORDER BY recorded_at DESC',
      [domain],
    );
    return rows.map(rowToSignal);
  }

  async findAll(): Promise<BacktestSignal[]> {
    const rows = await this.db.query<BacktestRow>(
      'SELECT * FROM backtest_signals ORDER BY recorded_at DESC, id DESC',
    );
    return rows.map(rowToSignal);
  }

  async count(): Promise<number> {
    const row = (await this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM backtest_signals'))!;
    return row.n;
  }

  async deleteAll(): Promise<void> {
    await this.db.exec('DELETE FROM backtest_signals');
  }
}
