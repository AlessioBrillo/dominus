import type { ComparableSale, CompsProvider } from './comps-provider.js';
import { getLogger } from '../../logger.js';

export interface NameBioProviderConfig {
  apiKey: string | undefined;
}

interface NameBioSale {
  name: string;
  price: number;
  date: string;
  venue: string;
  inventory?: boolean;
}

export class NameBioProvider implements CompsProvider {
  private readonly apiKey: string | undefined;
  private warned: boolean = false;

  constructor(config: NameBioProviderConfig) {
    this.apiKey = config.apiKey;
  }

  async getSales(term: string, signal?: AbortSignal): Promise<ComparableSale[]> {
    if (this.apiKey === undefined || this.apiKey === '') {
      if (!this.warned) {
        getLogger().warn(
          'NameBio API key is missing (NAMEBIO_API_KEY). Set it in .env to enable comparable sales lookups. Gracefully returning zero results.',
        );
        this.warned = true;
      }
      return [];
    }

    const url = `https://namebio.com/api?key=${encodeURIComponent(this.apiKey)}&domain=${encodeURIComponent(term)}`;

    let response: Response;
    try {
      const abortTimeout = AbortSignal.timeout(10_000);
      const combined = signal ? AbortSignal.any([signal, abortTimeout]) : abortTimeout;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: combined,
      });
    } catch (err: unknown) {
      getLogger().error(
        { err, term },
        'NameBio API request failed — returning zero comparable sales',
      );
      return [];
    }

    if (!response.ok) {
      getLogger().error(
        { status: response.status, term },
        'NameBio API returned non-OK status — returning zero comparable sales',
      );
      return [];
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      getLogger().error(
        { term },
        'NameBio API returned invalid JSON — returning zero comparable sales',
      );
      return [];
    }

    return this.parseResponse(data);
  }

  private parseResponse(data: unknown): ComparableSale[] {
    if (!Array.isArray(data)) return [];

    return data
      .filter((item): item is NameBioSale => {
        if (typeof item !== 'object' || item === null) return false;
        const candidate = item as Record<string, unknown>;
        return (
          typeof candidate.name === 'string' &&
          typeof candidate.price === 'number' &&
          !isNaN(candidate.price)
        );
      })
      .map((sale) => ({
        domain: sale.name,
        salePrice: sale.price,
        saleDate: sale.date ?? '',
        venue: sale.venue ?? '',
      }));
  }
}
