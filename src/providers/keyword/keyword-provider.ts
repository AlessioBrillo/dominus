// SPDX-License-Identifier: AGPL-3.0-only
export interface KeywordMetrics {
  term: string;
  monthlySearchVolume: number;
  cpc: number;
  competition: number;
  /**
   * False when this provider has no entry for the term. Zero volume/CPC
   * alone cannot express a miss: a real term can genuinely have zero demand.
   * Only providers that can distinguish the two should set this field.
   */
  covered?: boolean | undefined;
  /** Which leg of a composite provider produced the metrics, when known. */
  source?: string | undefined;
}

export interface KeywordProvider {
  getMetrics(term: string, signal?: AbortSignal): Promise<KeywordMetrics>;
}
