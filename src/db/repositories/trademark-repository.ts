import type Database from 'better-sqlite3';
import type { TrademarkMatch } from '../../providers/trademark/trademark-provider.js';

export interface TrademarkResultRow {
  id: number;
  candidate_id: number | null;
  search_term: string;
  source: string;
  match_found: number;
  match_details: string | null;
  raw_response: string | null;
  checked_at: string;
  expires_at: string;
}

export class TrademarkRepository {
  constructor(private readonly db: Database.Database) {}

  // ---------------------------------------------------------------------------
  // Term-keyed cache methods (primary interface for the caching provider)
  // ---------------------------------------------------------------------------

  /**
   * Persist a trademark search result keyed by the search term.
   * Used by CachedTrademarkProvider before any candidate DB id is available.
   */
  insertByTerm(
    searchTerm: string,
    source: string,
    matchFound: boolean,
    matchDetails: TrademarkMatch[] | null,
    rawResponse: unknown,
    ttlDays: number,
  ): void {
    const expiresAt = new Date(
      Date.now() + ttlDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    this.db
      .prepare(
        `INSERT INTO trademark_results
         (search_term, source, match_found, match_details, raw_response, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        searchTerm,
        source,
        matchFound ? 1 : 0,
        matchDetails ? JSON.stringify(matchDetails) : null,
        rawResponse ? JSON.stringify(rawResponse) : null,
        expiresAt,
      );
  }

  /**
   * Return the most recent non-expired cache row for the given (term, source)
   * pair, or null when the cache is cold or expired.
   */
  findValidByTerm(
    searchTerm: string,
    source: string,
  ): TrademarkResultRow | null {
    const now = new Date().toISOString();
    return (
      (this.db
        .prepare(
          `SELECT * FROM trademark_results
           WHERE search_term = ? AND source = ? AND expires_at > ?
           ORDER BY checked_at DESC LIMIT 1`,
        )
        .get(searchTerm, source, now) as TrademarkResultRow | undefined) ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // Candidate-linked methods (reserved for future post-run linking)
  // ---------------------------------------------------------------------------

  /** Link an existing term-cache row to a candidate id after persistence. */
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
