import { ProviderError } from '../../types/errors.js';
import type { ComparableSale, CompsProvider } from './comps-provider.js';
import { ManualCompsProvider } from './manual-comps-provider.js';
export { ManualCompsProvider };
export type { ComparableSale, CompsProvider };

export interface CompsProviderConfig {
  csvFilePath: string | undefined;
}

export function createCompsProvider(type: string, config: CompsProviderConfig): CompsProvider {
  switch (type) {
    case 'manual':
      return new ManualCompsProvider(config.csvFilePath);
    default:
      throw new ProviderError(
        `Unknown comps provider type: '${type}'. Valid types: manual`,
        'comps',
      );
  }
}
