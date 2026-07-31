import { randomUUID } from 'node:crypto';
import type { ScoringEngine } from '../scoring/index.js';
import type { ScoreResult } from '../types/score.js';
import type { TrademarkGate } from '../trademark/index.js';
import { isValidDomain, parseDomain } from '../utils/domain.js';
import { MemoryCache } from '../providers/cached-provider.js';
import type { PublicScoreRepository } from '../db/repositories/public-score-repository.js';
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

export interface PublicScoreData {
  slug: string;
  domain: string;
  score: ScoreResult;
  trademark: AnonTrademarkInfo | null;
  viewCount: number;
  createdAt: string;
}

export interface CompareScoreData {
  domain: string;
  score: ScoreResult;
  trademark: AnonTrademarkInfo | null;
}

export interface CompareResult {
  score1: CompareScoreData;
  score2: CompareScoreData;
}

export interface CreatedScoreResult {
  slug: string;
  url: string;
  domain: string;
}

export interface RecentScoreRow {
  slug: string;
  domain: string;
  created_at: string;
}

export interface OgScoreData {
  slug: string;
  domain: string;
  score_json: string;
  trademark_json: string | null;
}

interface ViewCountEntry {
  slug: string;
  count: number;
}

const VIEW_COUNT_FLUSH_INTERVAL_MS = 60_000;
const VIEW_COUNT_BUFFER_MAX = 5_000;
const VIEW_COUNT_RETRY_MAX = 1_000;

export class AnonScoringService {
  readonly #engine: ScoringEngine;
  readonly #trademarkGate: TrademarkGate | undefined;
  readonly #repo: PublicScoreRepository | undefined;
  readonly #cache: MemoryCache<AnonScoreResult>;
  readonly #scoreCache: MemoryCache<PublicScoreData>;
  readonly #compareCache: MemoryCache<CompareResult>;

  #viewCountBuffer: ViewCountEntry[] = [];
  #viewCountRetryBuffer: ViewCountEntry[] = [];
  #viewCountFlushTimer: ReturnType<typeof setInterval> | null = null;
  #viewCountFlushRunning = false;

  constructor(
    engine: ScoringEngine,
    trademarkGate?: TrademarkGate,
    cacheTtlMs: number = 300_000,
    maxCacheSize: number = 500,
    repo?: PublicScoreRepository,
  ) {
    this.#engine = engine;
    this.#trademarkGate = trademarkGate;
    this.#repo = repo;
    const cacheTtlSeconds = Math.ceil(cacheTtlMs / 1000);
    this.#cache = new MemoryCache<AnonScoreResult>(maxCacheSize, cacheTtlSeconds);
    this.#scoreCache = new MemoryCache<PublicScoreData>(maxCacheSize, cacheTtlSeconds);
    this.#compareCache = new MemoryCache<CompareResult>(maxCacheSize, cacheTtlSeconds);
  }

  async score(domain: string): Promise<AnonScoreResult> {
    if (!isValidDomain(domain)) {
      throw new DomainValidationError(domain);
    }

    const cacheKey = domain.toLowerCase();
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;

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

    this.#cache.set(cacheKey, result);

    return result;
  }

  clearCache(): void {
    this.#cache.clear();
    this.#scoreCache.clear();
    this.#compareCache.clear();
  }

  async createScore(domain: string): Promise<CreatedScoreResult> {
    if (!this.#repo) {
      throw new Error('PublicScoreRepository is required to create scores');
    }

    const scoreResult = await this.score(domain);
    const slug = randomUUID().replace(/-/g, '').slice(0, 12);
    const scoreJson = JSON.stringify(scoreResult.score);
    const trademarkJson = scoreResult.trademark ? JSON.stringify(scoreResult.trademark) : null;

    await this.#repo.insert(slug, domain, scoreJson, trademarkJson);

    return { slug, url: `/public/s/${slug}`, domain };
  }

  async getScoreBySlug(slug: string): Promise<PublicScoreData | null> {
    if (!this.#repo) return null;

    const cacheKey = `score:${slug}`;
    const cached = this.#scoreCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const row = await this.#repo.findBySlug(slug);
    if (!row) return null;

    const data: PublicScoreData = {
      slug: row.slug,
      domain: row.domain,
      score: JSON.parse(row.score_json) as ScoreResult,
      trademark: row.trademark_json ? (JSON.parse(row.trademark_json) as AnonTrademarkInfo) : null,
      viewCount: row.view_count,
      createdAt: row.created_at,
    };

    this.#scoreCache.set(cacheKey, data);

    return data;
  }

  async getCompareScores(slug1: string, slug2: string): Promise<CompareResult | null> {
    if (!this.#repo) return null;

    const cacheKey = `compare:${slug1}:${slug2}`;
    const cached = this.#compareCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const { row1, row2 } = await this.#repo.findBySlugsForCompare(slug1, slug2);
    if (!row1 || !row2) return null;

    const result: CompareResult = {
      score1: {
        domain: row1.domain,
        score: JSON.parse(row1.score_json) as ScoreResult,
        trademark: row1.trademark_json
          ? (JSON.parse(row1.trademark_json) as AnonTrademarkInfo)
          : null,
      },
      score2: {
        domain: row2.domain,
        score: JSON.parse(row2.score_json) as ScoreResult,
        trademark: row2.trademark_json
          ? (JSON.parse(row2.trademark_json) as AnonTrademarkInfo)
          : null,
      },
    };

    this.#compareCache.set(cacheKey, result);

    return result;
  }

  bumpViewCount(slug: string): void {
    this.#scheduleViewCountFlush();
    const existing = this.#viewCountBuffer.find((e) => e.slug === slug);
    if (existing) {
      existing.count++;
    } else {
      if (this.#viewCountBuffer.length >= VIEW_COUNT_BUFFER_MAX) {
        logger.warn(
          { slug },
          'AnonScoringService: view count buffer at max capacity, dropping entry',
        );
        return;
      }
      this.#viewCountBuffer.push({ slug, count: 1 });
    }
  }

  async #flushViewCounts(): Promise<void> {
    if (!this.#repo) return;
    if (this.#viewCountFlushRunning) return;
    this.#viewCountFlushRunning = true;
    try {
      // Flush the live buffer plus any previously failed entries. Failed
      // entries are NOT merged back into the live buffer — they go into a
      // dedicated retry buffer, so a slow/failing flush can never cause the
      // same view to be counted twice.
      const batch = [...this.#viewCountRetryBuffer, ...this.#viewCountBuffer];
      this.#viewCountBuffer = [];
      this.#viewCountRetryBuffer = [];
      if (batch.length === 0) return;
      for (const entry of batch) {
        try {
          await this.#repo.updateViewCount(entry.slug, entry.count);
        } catch (err) {
          logger.warn({ err, slug: entry.slug }, 'Failed to flush view_count');
          this.#enqueueViewCountRetry(entry);
        }
      }
    } finally {
      this.#viewCountFlushRunning = false;
    }
  }

  #enqueueViewCountRetry(entry: ViewCountEntry): void {
    const existing = this.#viewCountRetryBuffer.find((e) => e.slug === entry.slug);
    if (existing) {
      existing.count += entry.count;
    } else {
      if (this.#viewCountRetryBuffer.length >= VIEW_COUNT_RETRY_MAX) {
        logger.warn(
          { slug: entry.slug },
          'AnonScoringService: view count retry buffer at max capacity, dropping entry',
        );
        return;
      }
      this.#viewCountRetryBuffer.push({ slug: entry.slug, count: entry.count });
    }
  }

  #scheduleViewCountFlush(): void {
    if (this.#viewCountFlushTimer) return;
    this.#viewCountFlushTimer = setInterval(() => {
      void this.#flushViewCounts();
    }, VIEW_COUNT_FLUSH_INTERVAL_MS).unref();
  }

  async listRecentScores(days: number = 90, limit: number = 50000): Promise<RecentScoreRow[]> {
    if (!this.#repo) return [];
    return this.#repo.listRecentScores(days, limit);
  }

  async findForOgImage(slug: string): Promise<OgScoreData | null> {
    if (!this.#repo) return null;
    return this.#repo.findForOgImage(slug);
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
