import type Database from 'better-sqlite3';

export interface TrademarkResultRow {
  id: number;
  candidate_id: number;
  search_term: string;
  source: string;
  match_found: number;
  match_details: string | null;
  checked_at: string;
  expires_at: string;
}

export class TrademarkRepository {
  constructor(private readonly db: Database.Database) {}

  insert(
    candidateId: number,
    searchTerm: string,
    source: string,
    matchFound: boolean,
    matchDetails: unknown,
  ): void {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO trademark_results
         (candidate_id, search_term, source, match_found, match_details, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidateId,
        searchTerm,
        source,
        matchFound ? 1 : 0,
        matchDetails ? JSON.stringify(matchDetails) : null,
        expiresAt,
      );
  }

  findValid(candidateId: number, source: string): TrademarkResultRow | null {
    const now = new Date().toISOString();
    return (
      (this.db
        .prepare(
          `SELECT * FROM trademark_results
           WHERE candidate_id = ? AND source = ? AND expires_at > ?
           ORDER BY checked_at DESC LIMIT 1`,
        )
        .get(candidateId, source, now) as TrademarkResultRow | undefined) ?? null
    );
  }
}
