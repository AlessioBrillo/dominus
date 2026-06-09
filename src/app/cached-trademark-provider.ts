import type {
  TrademarkMatch,
  TrademarkProvider,
} from '../providers/trademark/trademark-provider.js';
import { CachedProvider } from '../providers/cached-provider.js';
import type { ProviderCacheRepository } from '../db/repositories/provider-cache-repository.js';

export class CachedTrademarkProvider implements TrademarkProvider {
  private readonly cache: CachedProvider<TrademarkMatch[]>;

  constructor(
    delegate: TrademarkProvider,
    cacheRepo: ProviderCacheRepository,
    source: string,
    ttlDays: number,
  ) {
    this.cache = new CachedProvider<TrademarkMatch[]>(
      (term) => delegate.search(term),
      cacheRepo,
      `trademark:${source}`,
      ttlDays,
      {
        serialize: (matches: TrademarkMatch[]): string => JSON.stringify(matches),
        deserialize: (raw: string): TrademarkMatch[] => {
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) return [];
          return parsed as TrademarkMatch[];
        },
      },
    );
  }

  async search(term: string): Promise<TrademarkMatch[]> {
    return this.cache.get(term);
  }
}
