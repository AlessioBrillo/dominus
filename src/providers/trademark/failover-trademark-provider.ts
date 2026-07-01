import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';
import { ProviderError } from '../../types/errors.js';

/**
 * FailoverTrademarkProvider — sequential trademark search with failover.
 *
 * Queries providers one at a time in configured order. Only falls
 * through to the next provider when the current one fails (network error,
 * timeout, non-2xx response).
 *
 * Sequential (not parallel) is deliberate:
 * - The first provider (USPTO) covers US marks for .com/.us domains,
 *   which is the common path. Failover is an edge case — only when
 *   the primary provider is unreachable.
 * - Parallel queries would consume the rate budget of both providers
 *   per domain, reducing effective throughput.
 *
 * ponytail: no widely-available free USPTO alternative endpoint exists
 * for the Elasticsearch-based search used by UsptoCasesProvider.
 * The default config has only one provider. Add a second in the
 * provider array when a viable free alternative appears, or configure
 * a self-hosted mirror endpoint via USPTO_SEARCH_URL.
 */
export class FailoverTrademarkProvider implements TrademarkProvider {
  readonly name: string;
  readonly #providers: TrademarkProvider[];

  constructor(providers: TrademarkProvider[]) {
    if (providers.length === 0) {
      throw new Error('FailoverTrademarkProvider requires at least one provider');
    }
    this.#providers = providers;
    this.name = `FailoverTrademarkProvider(${providers.map((p) => p.constructor.name).join(',')})`;
  }

  async search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const errors: string[] = [];
    for (const provider of this.#providers) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        return await provider.search(term, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.constructor.name}: ${msg}`);
      }
    }

    throw new ProviderError(
      `All trademark providers failed for term "${term}": [${errors.join('; ')}]`,
      this.name,
      'TM_FAILOVER_EXHAUSTED',
    );
  }
}
