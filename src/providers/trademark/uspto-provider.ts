import { ProviderNotImplementedError } from '../../types/errors.js';
import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';

export class UsptoCasesProvider implements TrademarkProvider {
  search(_term: string): Promise<TrademarkMatch[]> {
    return Promise.reject(new ProviderNotImplementedError('UsptoCasesProvider', 'search'));
  }
}
