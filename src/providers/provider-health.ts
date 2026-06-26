import type { TrademarkProvider } from './trademark/trademark-provider.js';
import type { RdapProvider } from './rdap/rdap-provider.js';
import type { WhoisProvider } from './whois/whois-provider.js';
import type { KeywordProvider } from './keyword/keyword-provider.js';
import type { DnsProvider } from './dns/node-dns-provider.js';
import type { CompsProvider } from './comps/comps-provider.js';
import type { WaybackProvider } from './wayback/wayback-provider.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface ProviderHealth {
  provider: string;
  status: 'ok' | 'unavailable' | 'error';
  latencyMs: number;
  message?: string;
}

export class ProviderHealthCheck {
  readonly #dnsProvider: DnsProvider | undefined;
  readonly #compsProvider: CompsProvider | undefined;
  readonly #waybackProvider: WaybackProvider | undefined;

  constructor(
    private readonly usptoProvider: TrademarkProvider,
    private readonly euipoProvider: TrademarkProvider,
    private readonly rdapProvider: RdapProvider,
    private readonly whoisProvider: WhoisProvider,
    private readonly keywordProvider: KeywordProvider,
    options?: {
      dnsProvider?: DnsProvider;
      compsProvider?: CompsProvider;
      waybackProvider?: WaybackProvider;
    },
  ) {
    this.#dnsProvider = options?.dnsProvider;
    this.#compsProvider = options?.compsProvider;
    this.#waybackProvider = options?.waybackProvider;
  }

  async checkAll(): Promise<ProviderHealth[]> {
    const checks: Array<{ name: string; fn: () => Promise<unknown> }> = [
      { name: 'USPTO', fn: () => this.usptoProvider.search('example') },
      { name: 'EUIPO', fn: () => this.euipoProvider.search('example') },
      { name: 'RDAP', fn: () => this.rdapProvider.confirm('example.com') },
      { name: 'WHOIS', fn: () => this.whoisProvider.checkAvailability('example.com') },
      { name: 'Keyword', fn: () => this.keywordProvider.getMetrics('example') },
    ];

    if (this.#dnsProvider) {
      checks.push({ name: 'DNS', fn: () => this.#dnsProvider!.checkAvailability('example.com') });
    }
    if (this.#compsProvider) {
      checks.push({ name: 'Comps', fn: () => this.#compsProvider!.getSales('example') });
    }
    if (this.#waybackProvider) {
      checks.push({
        name: 'Wayback',
        fn: () => this.#waybackProvider!.getExpiryData('example.com'),
      });
    }

    const results = await Promise.allSettled(checks.map((c) => this.checkProvider(c.name, c.fn)));

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
