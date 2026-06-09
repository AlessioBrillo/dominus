import { ProviderError } from '../../types/errors.js';
import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';
import { ManualKeywordProvider } from './manual-keyword-provider.js';
import { GoogleAdsProvider } from './google-ads-provider.js';
export { ManualKeywordProvider, GoogleAdsProvider };
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
      });
    default:
      throw new ProviderError(
        `Unknown keyword provider type: '${type}'. Valid types: manual, google-ads`,
        'keyword',
      );
  }
}
