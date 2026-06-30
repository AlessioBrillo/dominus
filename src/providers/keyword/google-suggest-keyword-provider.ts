import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';

const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';

const CACHE_TTL_MS = 86_400_000;

interface CacheEntry {
  metrics: KeywordMetrics;
  expiresAt: number;
}

export class GoogleSuggestKeywordProvider implements KeywordProvider {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #cacheTtlMs: number;

  constructor(cacheTtlMs: number = CACHE_TTL_MS) {
    this.#cacheTtlMs = cacheTtlMs;
  }

  async getMetrics(term: string, signal?: AbortSignal): Promise<KeywordMetrics> {
    const cached = this.#lookupCached(term);
    if (cached !== undefined) return cached;

    const suggestions = await this.#fetchSuggestions(term, signal);
    const metrics = this.#estimateMetrics(term, suggestions);

    this.#setCached(term, metrics);
    return metrics;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  #lookupCached(term: string): KeywordMetrics | undefined {
    const entry = this.#cache.get(term);
    if (entry && entry.expiresAt > Date.now()) return entry.metrics;
    this.#cache.delete(term);
    return undefined;
  }

  #setCached(term: string, metrics: KeywordMetrics): void {
    if (this.#cache.size >= 50000) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done && oldest.value !== undefined) {
        this.#cache.delete(oldest.value);
      }
    }
    this.#cache.set(term, { metrics, expiresAt: Date.now() + this.#cacheTtlMs });
  }

  async #fetchSuggestions(term: string, signal?: AbortSignal): Promise<string[]> {
    if (signal?.aborted) return [];

    const url = new URL(SUGGEST_URL);
    url.searchParams.set('client', 'firefox');
    url.searchParams.set('q', term);

    let response: Response;
    try {
      response = await fetch(url.toString(), { signal: signal ?? null });
    } catch {
      return [];
    }

    if (!response.ok) return [];

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return [];
    }

    if (!Array.isArray(data) || data.length < 2) return [];

    const suggestions = data[1];
    if (!Array.isArray(suggestions)) return [];

    return suggestions.filter((s): s is string => typeof s === 'string');
  }

  #estimateMetrics(term: string, suggestions: string[]): KeywordMetrics {
    const count = suggestions.length;

    const monthlySearchVolume = this.#estimateVolume(count);

    const cpc = this.#estimateCpc(term, count);

    const competition = this.#estimateCompetition(count, cpc);

    return { term, monthlySearchVolume, cpc, competition };
  }

  #estimateVolume(suggestionCount: number): number {
    if (suggestionCount === 0) return 0;
    if (suggestionCount <= 3) return 50;
    if (suggestionCount <= 5) return 300;
    if (suggestionCount <= 7) return 1500;
    if (suggestionCount <= 9) return 5000;
    return 10000;
  }

  #estimateCpc(term: string, suggestionCount: number): number {
    const clean = term.replace(/[^a-z0-9-]/gi, '');
    const hyphenCount = (clean.match(/-/g) ?? []).length;

    if (suggestionCount === 0) return 0;

    let cpc = 0.8;

    if (clean.length <= 5) cpc += 0.6;
    else if (clean.length <= 8) cpc += 0.3;

    if (suggestionCount >= 8) cpc += 0.4;
    else if (suggestionCount >= 5) cpc += 0.2;

    cpc -= hyphenCount * 0.25;

    return Math.max(0, Math.round(cpc * 100) / 100);
  }

  #estimateCompetition(suggestionCount: number, cpc: number): number {
    if (suggestionCount === 0) return 0;

    const volumeFactor = Math.min(suggestionCount / 10, 1);
    const cpcFactor = Math.min(cpc / 2, 1);

    return Math.round(Math.min(1, volumeFactor * 0.5 + cpcFactor * 0.5) * 100) / 100;
  }
}
