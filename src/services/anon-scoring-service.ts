import type { ScoringEngine } from '../scoring/index.js';
import type { ScoreResult } from '../types/score.js';
import type { TrademarkGate } from '../trademark/index.js';
import { isValidDomain, parseDomain } from '../utils/domain.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface AnonTrademarkInfo {
  verdict: string;
  verifiedSources: string[];
  matchedMark?: string | null;
  matchedOwner?: string | null;
}

export interface AnonScoreResult {
  domain: string;
  score: ScoreResult;
  trademark: AnonTrademarkInfo | null;
  scoredAt: string;
}

interface CacheEntry {
  data: AnonScoreResult;
  expiresAt: number;
}

export class AnonScoringService {
  readonly #engine: ScoringEngine;
  readonly #trademarkGate: TrademarkGate | undefined;
  readonly #cacheTtlMs: number;
  readonly #cache: Map<string, CacheEntry> = new Map();
  readonly #maxCacheSize: number;

  constructor(
    engine: ScoringEngine,
    trademarkGate?: TrademarkGate,
    cacheTtlMs: number = 300_000,
    maxCacheSize: number = 500,
  ) {
    this.#engine = engine;
    this.#trademarkGate = trademarkGate;
    this.#cacheTtlMs = cacheTtlMs;
    this.#maxCacheSize = maxCacheSize;
  }

  #prune(): void {
    if (this.#cache.size <= this.#maxCacheSize) return;
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.#cache) {
      if (now >= entry.expiresAt) {
        this.#cache.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.debug(
        { pruned, remaining: this.#cache.size },
        'AnonScoringService: pruned expired entries',
      );
    }
  }

  async score(domain: string): Promise<AnonScoreResult> {
    if (!isValidDomain(domain)) {
      throw new DomainValidationError(domain);
    }

    const cacheKey = domain.toLowerCase();
    const cached = this.#cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const parsed = parseDomain(domain);

    let trademark: AnonTrademarkInfo | null = null;
    if (this.#trademarkGate) {
      try {
        const gateResult = await this.#trademarkGate.check(domain);
        trademark = {
          verdict: gateResult.verdict,
          verifiedSources: gateResult.verifiedSources,
          matchedMark: gateResult.matchedMark ?? null,
          matchedOwner: gateResult.matchedOwner ?? null,
        };
      } catch (err) {
        logger.warn({ err, domain }, 'Trademark gate failed during anonymous scoring');
        trademark = { verdict: 'unverified', verifiedSources: [] };
      }
    }

    const scoreResult = await this.#engine.score({
      domain,
      tld: parsed.tld,
      sld: parsed.sld,
      isCloseout: false,
    });

    const result: AnonScoreResult = {
      domain,
      score: scoreResult,
      trademark,
      scoredAt: new Date().toISOString(),
    };

    this.#cache.set(cacheKey, { data: result, expiresAt: Date.now() + this.#cacheTtlMs });
    this.#prune();

    return result;
  }

  clearCache(): void {
    this.#cache.clear();
  }
}

export class DomainValidationError extends Error {
  readonly domain: string;
  constructor(domain: string) {
    super(`Invalid domain: '${domain}'`);
    this.name = 'DomainValidationError';
    this.domain = domain;
  }
}
