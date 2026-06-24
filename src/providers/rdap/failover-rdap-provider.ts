import type { RdapResult } from '../../types/domain-status.js';
import { ProviderError } from '../../types/errors.js';
import type { RdapProvider } from './rdap-provider.js';
import { PublicRdapProvider } from './public-rdap-provider.js';
import { type RateLimiter } from '../rate-limiter.js';

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
 * FailoverRdapProvider — parallel-first RDAP resolution.
 *
 * All configured RDAP servers are queried CONCURRENTLY via Promise.allSettled.
 * The first successful response wins; all other in-flight requests are aborted
 * via a shared AbortController. This eliminates the ~500ms sequential failover
 * delay per domain that the previous implementation incurred.
 *
 * When ALL servers fail, the combined error message is thrown as ProviderError
 * with every server's failure reason listed.
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

  static fromConfig(urls: string[], rateLimiter?: RateLimiter): FailoverRdapProvider {
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

    // Child controller lets us cancel all in-flight requests once one succeeds.
    const childAbort = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, childAbort.signal])
      : childAbort.signal;

    const results = await Promise.allSettled(
      this.#providers.map((provider) =>
        provider.confirm(domain, combinedSignal).then((result) => {
          childAbort.abort(); // Cancel remaining in-flight requests
          return result;
        }),
      ),
    );

    const errors: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Collect the failure reason
      const reason = result.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      errors.push(msg);
    }

    throw new ProviderError(
      `All RDAP bootstrap servers failed for ${domain}: [${errors.join('; ')}]`,
      this.name,
    );
  }
}
