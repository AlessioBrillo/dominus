// SPDX-License-Identifier: AGPL-3.0-only
export interface KeywordMetrics {
  term: string;
  monthlySearchVolume: number;
  cpc: number;
  competition: number;
}

export interface KeywordProvider {
  getMetrics(term: string, signal?: AbortSignal): Promise<KeywordMetrics>;
}
