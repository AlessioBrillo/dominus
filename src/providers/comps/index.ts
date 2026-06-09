import { ProviderError } from '../../types/errors.js';
import type { ComparableSale, CompsProvider } from './comps-provider.js';
import { ManualCompsProvider } from './manual-comps-provider.js';
import { NameBioProvider } from './namebio-provider.js';
export { ManualCompsProvider, NameBioProvider };
export type { ComparableSale, CompsProvider };

export interface CompsProviderConfig {
  csvFilePath: string | undefined;
  namebioApiKey: string | undefined;
}

export function createCompsProvider(type: string, config: CompsProviderConfig): CompsProvider {
  switch (type) {
    case 'manual':
      return new ManualCompsProvider(config.csvFilePath);
    case 'namebio':
      return new NameBioProvider({ apiKey: config.namebioApiKey });
    default:
      throw new ProviderError(
        `Unknown comps provider type: '${type}'. Valid types: manual, namebio`,
        'comps',
      );
  }
}
