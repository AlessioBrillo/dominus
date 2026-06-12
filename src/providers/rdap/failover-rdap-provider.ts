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

const DELAY_BETWEEN_FAILOVER_MS = 500;

export class FailoverRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #providers: RdapProvider[];

  constructor(
    providers?: RdapProvider[],
    private readonly delayBetweenFailoverMs = DELAY_BETWEEN_FAILOVER_MS,
  ) {
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

  static fromConfig(
    urls: string[],
    rateLimiter?: RateLimiter,
    delayMs = DELAY_BETWEEN_FAILOVER_MS,
  ): FailoverRdapProvider {
    const providers = urls.map((url, i) => {
      const name = `rdap-server-${i + 1}`;
      return new PublicRdapProvider(url, name, rateLimiter);
    });
    return new FailoverRdapProvider(providers, delayMs);
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    const errors: string[] = [];

    for (let i = 0; i < this.#providers.length; i++) {
      if (signal?.aborted) break;

      const provider = this.#providers[i];
      if (provider === undefined) continue;

      try {
        const result = await provider.confirm(domain, signal);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.name}: ${msg}`);
      }

      if (i < this.#providers.length - 1 && !signal?.aborted) {
        await sleep(this.delayBetweenFailoverMs);
      }
    }

    throw new ProviderError(
      `All RDAP bootstrap servers failed for ${domain}: [${errors.join('; ')}]`,
      this.name,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
