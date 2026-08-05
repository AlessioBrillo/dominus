// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderCacheRepository } from '../db/repositories/provider-cache-repository.js';

export interface CacheSerializer<T> {
  serialize(value: T): string;
  deserialize(raw: string): T;
}

/** @internal Creates a JSON-based serializer for any type T.
 * The cast via `JSON.parse(raw) as T` is intentional and contained:
 * this function is the single chokepoint for JSON serialization in the
 * caching layer. Callers should ensure T is JSON-serializable. */
function createJsonSerializer<T>(): CacheSerializer<T> {
  return {
    serialize: (v: T) => JSON.stringify(v),
    deserialize: (raw: string) => JSON.parse(raw) as T,
  };
}

interface MemCacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple LRU in-memory cache with TTL eviction.
 * Used as a fast fronting layer before the DB-backed cache.
 */
export class MemoryCache<T> {
  readonly #entries = new Map<string, MemCacheEntry<T>>();
  readonly #maxSize: number;
  readonly #ttlMs: number;

  constructor(maxSize: number, ttlSeconds: number) {
    this.#maxSize = maxSize;
    this.#ttlMs = ttlSeconds * 1000;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    // LRU promotion: delete and re-insert to move to end
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.#maxSize <= 0) return;
    if (this.#entries.has(key)) {
      this.#entries.delete(key);
    } else if (this.#entries.size >= this.#maxSize) {
      // Evict oldest (first inserted) entry
      const oldest = this.#entries.keys().next();
      if (!oldest.done && oldest.value !== undefined) {
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Remove only expired entries. Returns count of evicted entries. */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt < now) {
        this.#entries.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}

export class CachedProvider<T> {
  readonly #inflight = new Map<string, Promise<T>>();
  readonly #memoryCache: MemoryCache<T> | null;

  constructor(
    private readonly fetchFn: (term: string, signal?: AbortSignal) => Promise<T>,
    private readonly repo: ProviderCacheRepository,
    private readonly providerName: string,
    private readonly ttlDays: number,
    private readonly serializer: CacheSerializer<T>,
    memoryCacheSize: number = 0,
    memoryCacheTtlSeconds: number = 300,
    /**
     * Optional result filter. When provided, results rejected by the
     * predicate are NEVER written to the memory or DB caches, and cached
     * rows (e.g. written by an older version) that fail the predicate are
     * treated as cache misses so the live lookup runs again. Use it to keep
     * transient/non-definitive results (Unknown, Error) out of the
     * persistent cache.
     */
    private readonly shouldCache?: (result: T) => boolean,
    /**
     * Optional staleness gate for persisted rows. When provided, a DB-cached
     * value for which the gate returns `true` is treated as a cache miss so
     * the live lookup runs again (and refreshes the entry). Use it to give
     * time-sensitive verdicts (e.g. availability) a stale window shorter than
     * the full TTL instead of serving them blindly, mirroring the DNS layer.
     * Memory-cached entries are not gated: their TTL is in minutes, so they
     * are young enough.
     */
    private readonly isStale?: (value: T) => boolean,
  ) {
    this.#memoryCache =
      memoryCacheSize > 0 ? new MemoryCache<T>(memoryCacheSize, memoryCacheTtlSeconds) : null;
  }

  /**
   * Create a CachedProvider for JSON-serializable data types.
   * Uses JSON.stringify/JSON.parse as the serializer.
   */
  static createJson<T>(
    fetchFn: (term: string, signal?: AbortSignal) => Promise<T>,
    repo: ProviderCacheRepository,
    providerName: string,
    ttlDays: number,
    memoryCacheSize: number = 0,
    memoryCacheTtlSeconds: number = 300,
    shouldCache?: (result: T) => boolean,
    isStale?: (value: T) => boolean,
  ): CachedProvider<T> {
    return new CachedProvider<T>(
      fetchFn,
      repo,
      providerName,
      ttlDays,
      createJsonSerializer<T>(),
      memoryCacheSize,
      memoryCacheTtlSeconds,
      shouldCache,
      isStale,
    );
  }

  /** Clear the in-memory cache. Does NOT clear the DB-backed cache (TTL-based). */
  clearCache(): void {
    if (this.#memoryCache !== null) {
      this.#memoryCache.clear();
    }
  }

  /** Evict only expired entries from in-memory cache. Does NOT touch DB-backed cache. */
  pruneCache(): void {
    if (this.#memoryCache !== null) {
      this.#memoryCache.prune();
    }
  }

  async get(term: string, signal?: AbortSignal, options?: { forceRecheck?: boolean }): Promise<T> {
    // 1. In-memory cache (fastest) — used for within-run dedup even when
    //    forceRecheck is set; its TTL is in minutes so it cannot be stale
    //    enough to matter, mirroring the DNS layer.
    if (this.#memoryCache !== null) {
      const memCached = this.#memoryCache.get(term);
      if (memCached !== undefined) return memCached;
    }

    // 2. DB-backed cache. Skipped entirely when forceRecheck is true —
    //    closeout-like populations may have changed status since the last
    //    lookup (e.g. newly expired), so a stale row must not gate them.
    if (options?.forceRecheck !== true) {
      const dbCached = await this.repo.get(term, this.providerName);
      if (dbCached !== null) {
        try {
          const value = this.serializer.deserialize(dbCached);
          // A persisted result that is too old (stale gate) or that the
          // predicate rejects (e.g. a transient Unknown written before the
          // predicate existed) must not be served: fall through to a live
          // lookup instead.
          const stale = this.isStale !== undefined && this.isStale(value);
          if (!stale && (this.shouldCache === undefined || this.shouldCache(value))) {
            if (this.#memoryCache !== null) {
              this.#memoryCache.set(term, value);
            }
            return value;
          }
        } catch {
          // Corrupted cache row — fall through to live lookup
        }
      }
    }

    // 3. Request coalescing
    const existing = this.#inflight.get(term);
    if (existing !== undefined) return existing;

    const promise = this.fetchFn(term, signal)
      .then(async (result) => {
        if (this.shouldCache !== undefined && !this.shouldCache(result)) {
          return result;
        }
        // Write to both caches in parallel (non-fatal)
        if (this.#memoryCache !== null) {
          try {
            this.#memoryCache.set(term, result);
          } catch {
            // Non-fatal
          }
        }
        try {
          await this.repo.set(
            term,
            this.providerName,
            this.serializer.serialize(result),
            this.ttlDays,
          );
        } catch {
          // Non-fatal
        }
        return result;
      })
      .finally(() => {
        this.#inflight.delete(term);
      });

    this.#inflight.set(term, promise);
    return promise;
  }
}
