import type { DatabaseProvider } from '../provider/interface.js';
import type { ScoreResult } from '../../types/score.js';

export interface ScoringRow {
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
  weighted_score: number;
  recommended: number;
  signal_scores: string;
  scored_at: string;
}

export class ScoringRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async insert(candidateId: number, runId: string, result: ScoreResult): Promise<void> {
    await this.db.exec(
      `INSERT INTO scoring_runs
       (candidate_id, run_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score,
        expiry_score, weighted_score, recommended, signal_scores)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        result.weightedScore,
        result.recommended ? 1 : 0,
        JSON.stringify(result.breakdown),
      ],
    );
  }

  async findLatestByCandidate(candidateId: number): Promise<ScoringRow | null> {
    return await this.db.queryOne<ScoringRow>(
      'SELECT * FROM scoring_runs WHERE candidate_id = ? ORDER BY scored_at DESC LIMIT 1',
      [candidateId],
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
  async findByRunId(runId: string, candidateId: number): Promise<ScoringRow | null> {
    return await this.db.queryOne<ScoringRow>(
      'SELECT * FROM scoring_runs WHERE run_id = ? AND candidate_id = ? ORDER BY id DESC LIMIT 1',
      [runId, candidateId],
    );
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
  async pruneByRunIdPrefix(prefix: string, scoredBefore: string): Promise<number> {
    const info = await this.db.exec(
      `DELETE FROM scoring_runs
        WHERE run_id LIKE ?
          AND scored_at < ?`,
      [prefix, scoredBefore],
    );
    return info.changes;
  }
}
