import type { TrademarkProvider } from './trademark/trademark-provider.js';
import type { RdapProvider } from './rdap/rdap-provider.js';
import type { WhoisProvider } from './whois/whois-provider.js';
import type { KeywordProvider } from './keyword/keyword-provider.js';
import type { DnsProvider } from './dns/dns-provider.js';
import type { CompsProvider } from './comps/comps-provider.js';
import type { WaybackProvider } from './wayback/wayback-provider.js';
import type { RedisClient } from './redis/redis-client.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface WafStats {
  wafBlockCount: number;
  requestCount: number;
  wafBlockRate: number;
}

export interface ProviderHealth {
  provider: string;
  status: 'ok' | 'unavailable' | 'error';
  latencyMs: number;
  message?: string;
  wafBlockCount?: number;
  wafBlockRate?: number;
}

export class ProviderHealthCheck {
  readonly #dnsProvider: DnsProvider | undefined;
  readonly #compsProvider: CompsProvider | undefined;
  readonly #waybackProvider: WaybackProvider | undefined;
  readonly #redisClient: RedisClient | undefined;
  readonly #usptoWafStats: (() => WafStats) | undefined;

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
      redisClient?: RedisClient;
      /** Callback to read live USPTO WAF block stats after the health probe. */
      usptoWafStats?: () => WafStats;
    },
  ) {
    this.#dnsProvider = options?.dnsProvider;
    this.#compsProvider = options?.compsProvider;
    this.#waybackProvider = options?.waybackProvider;
    this.#redisClient = options?.redisClient;
    this.#usptoWafStats = options?.usptoWafStats;
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
    if (this.#redisClient) {
      checks.push({
        name: 'Redis',
        fn: () => this.#redisClient!.ping(),
      });
    }

    const results = await Promise.allSettled(checks.map((c) => this.checkProvider(c.name, c.fn)));

    const mapped = results.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        provider: 'unknown',
        status: 'error' as const,
        latencyMs: 0,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    // Attach USPTO WAF stats to the USPTO health entry
    if (this.#usptoWafStats) {
      const waf = this.#usptoWafStats();
      const usptoEntry = mapped.find((p) => p.provider === 'USPTO');
      if (usptoEntry && waf.wafBlockCount > 0) {
        usptoEntry.wafBlockCount = waf.wafBlockCount;
        usptoEntry.wafBlockRate = waf.wafBlockRate;
        usptoEntry.message = `${waf.wafBlockCount} WAF blocks in ${waf.requestCount} requests (rate: ${(waf.wafBlockRate * 100).toFixed(1)}%)`;
      }
    }

    return mapped;
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
