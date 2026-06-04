import type { TrademarkMatch, TrademarkProvider } from '../providers/trademark/trademark-provider.js';
import type { TrademarkRepository } from '../db/repositories/trademark-repository.js';

/**
 * Caching decorator for TrademarkProvider.
 *
 * Wraps a real provider with a 7-day (configurable) term-keyed SQLite cache
 * so repeat pipeline runs don't re-hit rate-limited free trademark APIs for
 * the same search terms.
 *
 * Lives in src/app/ because it is the only layer permitted to depend on both
 * src/providers/ and src/db/ — exactly like PipelineRunService. The
 * TrademarkGate and pipeline stages remain database-agnostic (Principle 1).
 *
 * Delegate errors propagate unchanged so the gate counts the source as down
 * on a genuine network failure (as opposed to a cache miss which is silent).
 */
export class CachedTrademarkProvider implements TrademarkProvider {
  constructor(
    private readonly delegate: TrademarkProvider,
    private readonly repo: TrademarkRepository,
    private readonly source: string,
    private readonly ttlDays: number,
  ) {}

  async search(term: string): Promise<TrademarkMatch[]> {
    const cached = this.repo.findValidByTerm(term, this.source);

    if (cached !== null) {
      // Cache hit: deserialise and return without calling the delegate
      if (cached.match_details === null) return [];
      try {
        const parsed = JSON.parse(cached.match_details) as unknown;
        if (Array.isArray(parsed)) return parsed as TrademarkMatch[];
      } catch {
        // Corrupted cache row — fall through to live lookup
      }
    }

    // Cache miss or corrupted: call the real provider
    const matches = await this.delegate.search(term);

    // Persist the result (don't let a cache write failure propagate)
    try {
      this.repo.insertByTerm(
        term,
        this.source,
        matches.length > 0,
        matches.length > 0 ? matches : null,
        null, // raw_response not needed for match caching
        this.ttlDays,
      );
    } catch {
      // Non-fatal: a cache write failure never blocks pipeline progress
    }

    return matches;
  }
}
