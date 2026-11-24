// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError } from '../../types/errors.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';
import { ManualKeywordProvider } from './manual-keyword-provider.js';
import { GoogleAdsProvider } from './google-ads-provider.js';
import { GoogleSuggestKeywordProvider } from './google-suggest-keyword-provider.js';
import { CompositeKeywordProvider } from './composite-keyword-provider.js';
export {
  ManualKeywordProvider,
  GoogleAdsProvider,
  GoogleSuggestKeywordProvider,
  CompositeKeywordProvider,
};
export type { KeywordMetrics, KeywordProvider };

export interface KeywordProviderConfig {
  dataFilePath: string | undefined;
  googleAdsClientId: string | undefined;
  googleAdsClientSecret: string | undefined;
  googleAdsRefreshToken: string | undefined;
  googleAdsDeveloperToken: string | undefined;
  googleAdsCustomerId: string | undefined;
}

export function createKeywordProvider(
  type: string,
  config: KeywordProviderConfig,
  cacheRepo?: ProviderCacheRepository,
): KeywordProvider {
  switch (type) {
    case 'manual':
      return new ManualKeywordProvider(config.dataFilePath);
    case 'google-ads':
      return new GoogleAdsProvider({
        clientId: config.googleAdsClientId,
        clientSecret: config.googleAdsClientSecret,
        refreshToken: config.googleAdsRefreshToken,
        developerToken: config.googleAdsDeveloperToken,
        customerId: config.googleAdsCustomerId,
        cacheRepo,
      });
    case 'google-suggest':
      return new GoogleSuggestKeywordProvider();
    case 'composite':
      // Curated data wins when present; Google Suggest answers only for terms
      // the dataset does not cover. A Google Ads-backed primary can be added
      // later without changing the scoring engine (ADR-0004).
      return new CompositeKeywordProvider(
        new ManualKeywordProvider(config.dataFilePath),
        new GoogleSuggestKeywordProvider(),
      );
    default:
      throw new ProviderError(
        `Unknown keyword provider type: '${type}'. Valid types: manual, google-ads, google-suggest, composite`,
        'keyword',
      );
  }
}
