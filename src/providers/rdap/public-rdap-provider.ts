import { DomainStatus } from '../../types/domain-status.js';
import type { RdapResult } from '../../types/domain-status.js';
import { ProviderError } from '../../types/errors.js';
import type { RdapProvider } from './rdap-provider.js';
import { RateLimiter } from '../rate-limiter.js';

const DEFAULT_RDAP_TIMEOUT_MS = 10_000;

interface RdapResponse {
  ldhName?: string;
  status?: string[];
  notices?: { description?: string[] }[];
}

export class PublicRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #baseUrl: string;
  readonly #rateLimiter: RateLimiter;
  readonly #timeoutMs: number;

  constructor(
    baseUrl = 'https://rdap.org/domain/',
    name?: string,
    rateLimiter?: RateLimiter,
    timeoutMs = DEFAULT_RDAP_TIMEOUT_MS,
  ) {
    this.#baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.name = name ?? 'PublicRdapProvider';
    this.#rateLimiter = rateLimiter ?? RateLimiter.unlimited();
    this.#timeoutMs = timeoutMs;
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    return this.#rateLimiter.throttle(() => this.#doConfirm(domain, signal));
  }

  async #doConfirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    const url = `${this.#baseUrl}${encodeURIComponent(domain)}`;
    let response: Response;

    try {
      response = await fetch(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)])
          : AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err: unknown) {
      throw new ProviderError(`RDAP request failed for ${domain}: ${String(err)}`, this.name);
    }

    if (response.status === 404) {
      return {
        domain,
        status: DomainStatus.Available,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      };
    }

    if (!response.ok) {
      return {
        domain,
        status: DomainStatus.Unknown,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      };
    }

    const data = (await response.json()) as RdapResponse;
    const isPremium = this.detectPremium(data);

    return {
      domain,
      status: DomainStatus.Registered,
      isPremium,
      checkedAt: new Date().toISOString(),
      rawResponse: data,
    };
  }

  private detectPremium(data: RdapResponse): boolean {
    const notices = data.notices ?? [];
    return notices.some((n) => (n.description ?? []).some((d) => /premium/i.test(d)));
  }
}
