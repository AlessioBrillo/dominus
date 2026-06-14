import type { Config } from '../config.js';
import type { ProviderCacheRepository } from '../db/index.js';
import {
  createKeywordProvider,
  type KeywordProvider,
  type KeywordMetrics,
} from '../providers/keyword/index.js';
import { createCompsProvider, type CompsProvider } from '../providers/comps/index.js';
import type { ComparableSale } from '../providers/comps/comps-provider.js';
import { CachedProvider } from '../providers/cached-provider.js';
import { NodeDnsProvider } from '../providers/dns/index.js';
import { type DnsProvider } from '../providers/dns/dns-provider.js';
import { RateLimiter } from '../providers/rate-limiter.js';
import { FailoverRdapProvider } from '../providers/rdap/index.js';
import { type RdapProvider } from '../providers/rdap/rdap-provider.js';
import type { RdapResult } from '../types/domain-status.js';
import {
  NodeWhoisProviderWithIanaFallback,
  buildPerTldWhoisRateLimiters,
} from '../providers/whois/index.js';
import { withRetry } from '../providers/retryable-provider.js';

export function buildKeywordProvider(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
): { raw: KeywordProvider; cached: KeywordProvider } {
  const raw = createKeywordProvider(
    config.KEYWORD_PROVIDER,
    {
      dataFilePath: config.KEYWORD_DATA_PATH,
      googleAdsClientId: config.GOOGLE_ADS_CLIENT_ID,
      googleAdsClientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
      googleAdsRefreshToken: config.GOOGLE_ADS_REFRESH_TOKEN,
      googleAdsDeveloperToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
      googleAdsCustomerId: config.GOOGLE_ADS_CUSTOMER_ID,
    },
    providerCacheRepo,
  );

  const cache = new CachedProvider<KeywordMetrics>(
    (term, signal) => raw.getMetrics(term, signal),
    providerCacheRepo,
    'keyword',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
  );
  const cached: KeywordProvider = {
    getMetrics: (term: string, signal?: AbortSignal) => cache.get(term, signal),
  };

  return { raw, cached };
}

export function buildCompsProvider(
  config: Config,
  providerCacheRepo: ProviderCacheRepository,
): { raw: CompsProvider; cached: CompsProvider } {
  const raw = createCompsProvider(config.COMPS_PROVIDER, {
    csvFilePath: config.COMPS_DATA_PATH,
    namebioApiKey: config.NAMEBIO_API_KEY,
  });

  const cache = new CachedProvider<ComparableSale[]>(
    (term, signal) => raw.getSales(term, signal),
    providerCacheRepo,
    'comps',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
  );
  const cached: CompsProvider = {
    getSales: (term: string, signal?: AbortSignal) => cache.get(term, signal),
  };

  return { raw, cached };
}

export interface BuiltRdapProviders {
  raw: RdapProvider;
  withRetry: RdapProvider;
  cached: RdapProvider;
}

export function buildRdapProviders(
  config: Config,
  rdapRateLimiter: RateLimiter,
  providerCacheRepo: ProviderCacheRepository,
): BuiltRdapProviders {
  const rdapBootstrapUrls: string[] = ((): string[] => {
    if (!config.RDAP_BOOTSTRAP_URLS) return [];
    try {
      return JSON.parse(config.RDAP_BOOTSTRAP_URLS) as string[];
    } catch {
      return [];
    }
  })();

  const raw: RdapProvider =
    rdapBootstrapUrls.length > 0
      ? FailoverRdapProvider.fromConfig(rdapBootstrapUrls, rdapRateLimiter)
      : new FailoverRdapProvider();

  const withRetryProvider: RdapProvider = {
    name: `${raw.name}(retry)`,
    confirm: (domain: string, signal?: AbortSignal) =>
      withRetry(
        (s) => raw.confirm(domain, s),
        `rdap:${domain}`,
        { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 1000 },
        signal,
      ),
  };

  const rdapCache = new CachedProvider<RdapResult>(
    (domain, signal) => withRetryProvider.confirm(domain, signal),
    providerCacheRepo,
    'rdap',
    config.PROVIDER_CACHE_TTL_DAYS ?? 7,
  );
  const cached: RdapProvider = {
    name: `${withRetryProvider.name}(cache)`,
    confirm: (domain: string, signal?: AbortSignal) => rdapCache.get(domain, signal),
  };

  return { raw, withRetry: withRetryProvider, cached };
}

export function buildDnsProvider(): DnsProvider {
  const dnsWithRetry: DnsProvider = {
    checkAvailability: (domain: string, signal?: AbortSignal) =>
      withRetry(
        (s) => new NodeDnsProvider().checkAvailability(domain, s),
        `dns:${domain}`,
        { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 },
        signal,
      ),
    checkBulk: async (domains: string[], signal?: AbortSignal) => {
      const dns = new NodeDnsProvider();
      return dns.checkBulk(domains, signal);
    },
  };
  return dnsWithRetry;
}

export interface BuiltWhoisProvider {
  provider: NodeWhoisProviderWithIanaFallback;
}

export function buildWhoisProviders(config: Config): BuiltWhoisProvider {
  const whoisDefaultLimiter = new RateLimiter({
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  });

  const whoisPerTldLimiters = buildPerTldWhoisRateLimiters(config.WHOIS_RATE_LIMIT_OVERRIDES, {
    maxTokens: config.WHOIS_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.WHOIS_RATE_LIMIT_TOKENS,
    intervalMs: config.WHOIS_RATE_LIMIT_INTERVAL_MS,
  });

  const provider = new NodeWhoisProviderWithIanaFallback({
    timeoutMs: config.WHOIS_LOOKUP_TIMEOUT,
    defaultRateLimiter: whoisDefaultLimiter,
    perTldRateLimiters: whoisPerTldLimiters,
  });

  return { provider };
}

export interface BuiltRateLimiters {
  rdap: RateLimiter;
}

export function buildRateLimiters(config: Config): BuiltRateLimiters {
  const rdap = new RateLimiter({
    maxTokens: config.RDAP_RATE_LIMIT_TOKENS,
    tokensPerInterval: config.RDAP_RATE_LIMIT_TOKENS,
    intervalMs: config.RDAP_RATE_LIMIT_INTERVAL_MS,
  });
  return { rdap };
}
