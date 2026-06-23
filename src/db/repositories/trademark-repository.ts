import type { DatabaseProvider } from '../provider/interface.js';
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
  constructor(private readonly db: DatabaseProvider) {}

  // ---------------------------------------------------------------------------
  // Term-keyed cache methods (primary interface for the caching provider)
  // ---------------------------------------------------------------------------

  /**
   * Persist a trademark search result keyed by the search term.
   * Used by CachedTrademarkProvider before any candidate DB id is available.
   */
  async insertByTerm(
    searchTerm: string,
    source: string,
    matchFound: boolean,
    matchDetails: TrademarkMatch[] | null,
    rawResponse: unknown,
    ttlDays: number,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    await this.db.exec(
      `INSERT INTO trademark_results
       (search_term, source, match_found, match_details, raw_response, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        searchTerm,
        source,
        matchFound ? 1 : 0,
        matchDetails ? JSON.stringify(matchDetails) : null,
        rawResponse ? JSON.stringify(rawResponse) : null,
        expiresAt,
      ],
    );
  }

  /**
   * Return the most recent non-expired cache row for the given (term, source)
   * pair, or null when the cache is cold or expired.
   */
  async findValidByTerm(searchTerm: string, source: string): Promise<TrademarkResultRow | null> {
    const now = new Date().toISOString();
    return await this.db.queryOne<TrademarkResultRow>(
      `SELECT * FROM trademark_results
       WHERE search_term = ? AND source = ? AND expires_at > ?
       ORDER BY checked_at DESC LIMIT 1`,
      [searchTerm, source, now],
    );
  }

  // ---------------------------------------------------------------------------
  // Candidate-linked methods (reserved for future post-run linking)
  // ---------------------------------------------------------------------------

  /** Link an existing term-cache row to a candidate id after persistence. */
  async insert(
    candidateId: number,
    searchTerm: string,
    source: string,
    matchFound: boolean,
    matchDetails: unknown,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await this.db.exec(
      `INSERT INTO trademark_results
       (candidate_id, search_term, source, match_found, match_details, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        searchTerm,
        source,
        matchFound ? 1 : 0,
        matchDetails ? JSON.stringify(matchDetails) : null,
        expiresAt,
      ],
    );
  }

  async findValid(candidateId: number, source: string): Promise<TrademarkResultRow | null> {
    const now = new Date().toISOString();
    return await this.db.queryOne<TrademarkResultRow>(
      `SELECT * FROM trademark_results
       WHERE candidate_id = ? AND source = ? AND expires_at > ?
       ORDER BY checked_at DESC LIMIT 1`,
      [candidateId, source, now],
    );
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /**
   * Delete every row whose `expires_at` is strictly in the past. Returns
   * the number of rows removed. Idempotent — a second call is a no-op.
   *
   * The cache TTL defaults to 7 days but the term-keyed cache (`insertByTerm`)
   * accepts a per-call `ttlDays`; rows are pruned uniformly on `expires_at`.
   * Operators can run this on demand (`dominus maintenance prune --cache-only`)
   * or as a scheduled job.
   */
  async pruneExpired(now: string = new Date().toISOString()): Promise<number> {
    const result = await this.db.exec('DELETE FROM trademark_results WHERE expires_at < ?', [now]);
    return Number(result.changes);
  }

  /** Total row count (for diagnostics). */
  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM trademark_results');
    return row!.n;
  }
}
