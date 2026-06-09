import type { ProviderCacheRepository } from '../db/repositories/provider-cache-repository.js';

export interface CacheSerializer<T> {
  serialize(value: T): string;
  deserialize(raw: string): T;
}

export const JSON_SERIALIZER: CacheSerializer<unknown> = {
  serialize: (v) => JSON.stringify(v),
  deserialize: (raw) => JSON.parse(raw) as unknown,
};

export class CachedProvider<T> {
  constructor(
    private readonly fetchFn: (term: string) => Promise<T>,
    private readonly repo: ProviderCacheRepository,
    private readonly providerName: string,
    private readonly ttlDays: number,
    private readonly serializer: CacheSerializer<T> = JSON_SERIALIZER as unknown as CacheSerializer<T>,
  ) {}

  async get(term: string): Promise<T> {
    const cached = this.repo.get(term, this.providerName);
    if (cached !== null) {
      try {
        return this.serializer.deserialize(cached);
      } catch {
        // Corrupted cache row — fall through to live lookup
      }
    }

    const result = await this.fetchFn(term);

    try {
      this.repo.set(term, this.providerName, this.serializer.serialize(result), this.ttlDays);
    } catch {
      // Non-fatal: cache write failure never blocks pipeline progress
    }

    return result;
  }
}
