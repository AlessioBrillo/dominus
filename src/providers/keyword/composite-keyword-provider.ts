// SPDX-License-Identifier: AGPL-3.0-only
import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';

/**
 * Tries a curated dataset first and falls back to a live provider only when
 * the dataset explicitly reports a miss.
 *
 * The distinction matters: `ManualKeywordProvider` used to return zeros for
 * a missing term, which the scoring engine could not tell apart from a real
 * zero-demand keyword. With `covered: false` the fallback is deliberate and
 * the resulting `source` is carried into the score's signal status, so a
 * reader can see that the commercial signal came from an estimate.
 *
 * ADR-0004 requires provider composition to live in one implementation file;
 * core scoring code does not know which leg answered.
 */
export class CompositeKeywordProvider implements KeywordProvider {
  constructor(
    private readonly primary: KeywordProvider,
    private readonly fallback: KeywordProvider,
  ) {}

  async getMetrics(term: string, signal?: AbortSignal): Promise<KeywordMetrics> {
    let primary: KeywordMetrics;
    try {
      primary = await this.primary.getMetrics(term, signal);
    } catch {
      // An unavailable curated dataset must not disable the fallback.
      primary = { term, monthlySearchVolume: 0, cpc: 0, competition: 0, covered: false };
    }

    if (primary.covered !== false) return primary;

    const fallback = await this.fallback.getMetrics(term, signal);
    return { ...fallback, source: fallback.source ?? 'fallback' };
  }
}
