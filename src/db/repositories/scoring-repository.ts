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
  weights_snapshot: string;
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
          expiry_score, weights_snapshot)
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
}
