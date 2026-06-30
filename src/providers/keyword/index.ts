import { ProviderError } from '../../types/errors.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';
import { ManualKeywordProvider } from './manual-keyword-provider.js';
import { GoogleAdsProvider } from './google-ads-provider.js';
import { GoogleSuggestKeywordProvider } from './google-suggest-keyword-provider.js';
export { ManualKeywordProvider, GoogleAdsProvider, GoogleSuggestKeywordProvider };
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
    default:
      throw new ProviderError(
        `Unknown keyword provider type: '${type}'. Valid types: manual, google-ads, google-suggest`,
        'keyword',
      );
  }
}
