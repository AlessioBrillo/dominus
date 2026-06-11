import type Database from 'better-sqlite3';
import type { ScoreResult } from '../../types/score.js';

interface ScoringRow {
  id: number;
  candidate_id: number;
  run_id: string;
  expected_value: number;
  confidence: number;
  suggested_buy_max: number;
  suggested_list_price: number;
  intrinsic_score: number;
  commercial_score: number;
  market_score: number;
  expiry_score: number;
  signal_scores: string;
  scored_at: string;
}

export class ScoringRepository {
  constructor(private readonly db: Database.Database) {}

  insert(candidateId: number, runId: string, result: ScoreResult): void {
    this.db
      .prepare(
        `INSERT INTO scoring_runs
         (candidate_id, run_id, expected_value, confidence, suggested_buy_max,
          suggested_list_price, intrinsic_score, commercial_score, market_score,
          expiry_score, signal_scores)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidateId,
        runId,
        result.expectedValue,
        result.confidence,
        result.suggestedBuyMax,
        result.suggestedListPrice,
        result.breakdown.intrinsic.score,
        result.breakdown.commercial.score,
        result.breakdown.market.score,
        result.breakdown.expiry.score,
        JSON.stringify(result.breakdown),
      );
  }

  findLatestByCandidate(candidateId: number): ScoringRow | null {
    return (
      (this.db
        .prepare(
          'SELECT * FROM scoring_runs WHERE candidate_id = ? ORDER BY scored_at DESC LIMIT 1',
        )
        .get(candidateId) as ScoringRow | undefined) ?? null
    );
  }

  /**
   * Look up a scoring run by its `run_id` and `candidate_id`. Returns null
   * if no row matches. The backtest engine and weight suggester use this
   * to re-derive per-signal scores from the snapshot picked at point-in-time
   * join time.
   *
   * The `candidate_id` filter is required: a single `run_id` can be shared
   * by many candidates in the same pipeline run, and `run_id` alone is
   * not a unique key on this table.
   */
  findByRunId(runId: string, candidateId: number): ScoringRow | null {
    const row = this.db
      .prepare(
        'SELECT * FROM scoring_runs WHERE run_id = ? AND candidate_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(runId, candidateId) as ScoringRow | undefined;
    return row ?? null;
  }

  /**
   * Delete scoring_runs rows whose run_id matches the given LIKE prefix
   * and whose scored_at is older than the provided cutoff (ISO-8601).
   * Returns the number of deleted rows.
   *
   * Designed for pruning stale portfolio-rescore entries (see
   * PortfolioRescoreService.pruneRetention). Uses a LIKE filter so
   * the caller controls the prefix scope.
   */
  pruneByRunIdPrefix(prefix: string, scoredBefore: string): number {
    const info = this.db
      .prepare(
        `DELETE FROM scoring_runs
          WHERE run_id LIKE ?
            AND scored_at < ?`,
      )
      .run(prefix, scoredBefore);
    return info.changes;
  }
}
