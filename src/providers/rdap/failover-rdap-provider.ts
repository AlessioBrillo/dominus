import type { RdapResult } from '../../types/domain-status.js';
import { ProviderError } from '../../types/errors.js';
import type { RdapProvider } from './rdap-provider.js';
import { PublicRdapProvider } from './public-rdap-provider.js';
import { type RateLimiterLike } from '../rate-limiter.js';

export interface RdapBootstrapConfig {
  baseUrl: string;
  name: string;
}

const DEFAULT_BOOTSTRAP_SERVERS: RdapBootstrapConfig[] = [
  { baseUrl: 'https://rdap.org/domain/', name: 'rdap.org' },
  { baseUrl: 'https://rdap.verisign.com/com/domain/', name: 'verisign-rdap' },
  { baseUrl: 'https://rdap.nic.google/domain/', name: 'google-rdap' },
];

/**
 * FailoverRdapProvider — sequential RDAP resolution with failover.
 *
 * Queries bootstrap servers one at a time in configured order. Only falls
 * through to the next server when the current one fails (network error,
 * timeout, non-2xx response that is not 404).
 *
 * Sequential (not parallel) is deliberate:
 * - All servers share the same rate limiter in the default setup. Parallel
 *   queries consume N tokens per domain (3x burst), reducing effective
 *   throughput and risking 429 from authoritative servers.
 * - rdap.org covers all TLDs, so >99% of queries resolve on the first
 *   attempt. Failover is an edge case, not the common path.
 * - The ~500ms failover penalty is incurred only on actual failures.
 */
export class FailoverRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #providers: RdapProvider[];

  constructor(providers?: RdapProvider[]) {
    if (providers) {
      this.#providers = providers;
      this.name = `FailoverRdapProvider(${providers.map((s) => s.name).join(',')})`;
    } else {
      this.#providers = DEFAULT_BOOTSTRAP_SERVERS.map(
        (cfg) => new PublicRdapProvider(cfg.baseUrl, cfg.name),
      );
      this.name = `FailoverRdapProvider(${DEFAULT_BOOTSTRAP_SERVERS.map((s) => s.name).join(',')})`;
    }
  }

  static fromConfig(urls: string[], rateLimiter?: RateLimiterLike): FailoverRdapProvider {
    const providers = urls.map((url, i) => {
      const name = `rdap-server-${i + 1}`;
      return new PublicRdapProvider(url, name, rateLimiter);
    });
    return new FailoverRdapProvider(providers);
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const errors: string[] = [];
    for (const provider of this.#providers) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const result = await provider.confirm(domain, signal);
        // A successful response (including 404 = Available, 503 = Unknown)
        // counts as resolved — no need to fall through.
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.name}: ${msg}`);
        // Fall through to the next bootstrap server
      }
    }

    throw new ProviderError(
      `All RDAP bootstrap servers failed for ${domain}: [${errors.join('; ')}]`,
      this.name,
    );
  }
}
