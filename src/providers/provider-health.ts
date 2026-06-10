import type { TrademarkProvider } from './trademark/trademark-provider.js';
import type { RdapProvider } from './rdap/rdap-provider.js';
import type { WhoisProvider } from './whois/whois-provider.js';
import type { KeywordProvider } from './keyword/keyword-provider.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface ProviderHealth {
  provider: string;
  status: 'ok' | 'unavailable' | 'error';
  latencyMs: number;
  message?: string;
}

export class ProviderHealthCheck {
  constructor(
    private readonly usptoProvider: TrademarkProvider,
    private readonly euipoProvider: TrademarkProvider,
    private readonly rdapProvider: RdapProvider,
    private readonly whoisProvider: WhoisProvider,
    private readonly keywordProvider: KeywordProvider,
  ) {}

  async checkAll(): Promise<ProviderHealth[]> {
    const results = await Promise.allSettled([
      this.checkProvider('USPTO', () => this.usptoProvider.search('example')),
      this.checkProvider('EUIPO', () => this.euipoProvider.search('example')),
      this.checkProvider('RDAP', () => this.rdapProvider.confirm('example.com')),
      this.checkProvider('WHOIS', () => this.whoisProvider.checkAvailability('example.com')),
      this.checkProvider('Keyword', () => this.keywordProvider.getMetrics('example')),
    ]);

    return results.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        provider: 'unknown',
        status: 'error' as const,
        latencyMs: 0,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });
  }

  private async checkProvider(name: string, fn: () => Promise<unknown>): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      await fn();
      return { provider: name, status: 'ok', latencyMs: Date.now() - start };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ provider: name, err: message }, 'Provider health check failed');
      return {
        provider: name,
        status: 'error',
        latencyMs: Date.now() - start,
        message,
      };
    }
  }
}
