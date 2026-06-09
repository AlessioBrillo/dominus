import { ProviderError } from '../../types/errors.js';
import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';
import { ManualKeywordProvider } from './manual-keyword-provider.js';
export { ManualKeywordProvider };
export type { KeywordMetrics, KeywordProvider };

export interface KeywordProviderConfig {
  dataFilePath: string | undefined;
}

export function createKeywordProvider(
  type: string,
  config: KeywordProviderConfig,
): KeywordProvider {
  switch (type) {
    case 'manual':
      return new ManualKeywordProvider(config.dataFilePath);
    default:
      throw new ProviderError(
        `Unknown keyword provider type: '${type}'. Valid types: manual`,
        'keyword',
      );
  }
}
