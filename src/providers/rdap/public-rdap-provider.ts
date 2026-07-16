import { DomainStatus } from '../../types/domain-status.js';
import type { RdapResult } from '../../types/domain-status.js';
import { ProviderError } from '../../types/errors.js';
import type { RdapProvider } from './rdap-provider.js';
import { type RateLimiterLike, RateLimiter } from '../rate-limiter.js';

const DEFAULT_RDAP_TIMEOUT_MS = 10_000;

/** Sleep for `ms` milliseconds, aborting early when `signal` is triggered. */
function raceTimeout(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms).unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RdapNotice {
  description?: string[];
  title?: string;
  links?: { value?: string; rel?: string; href?: string }[];
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  handle?: string;
  roles?: string[];
  vcardArray?: unknown[];
  entities?: RdapEntity[];
}

interface RdapResponse {
  ldhName?: string;
  status?: string[];
  notices?: RdapNotice[];
  events?: RdapEvent[];
  entities?: RdapEntity[];
}

export class PublicRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #baseUrl: string;
  readonly #rateLimiter: RateLimiterLike;
  readonly #timeoutMs: number;

  constructor(
    baseUrl = 'https://rdap.org/domain/',
    name?: string,
    rateLimiter?: RateLimiterLike,
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

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      let waitMs = 5000;
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        waitMs = isNaN(parsed) ? 5000 : parsed * 1000;
      }
      const capped = Math.min(waitMs, 30_000);
      await raceTimeout(capped, signal);
      throw new ProviderError(
        `RDAP rate limited (429) for ${domain} — retried after ${capped}ms`,
        this.name,
      );
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
    const isPremium = PublicRdapProvider.detectPremium(data);

    return {
      domain,
      status: DomainStatus.Registered,
      isPremium,
      checkedAt: new Date().toISOString(),
      rawResponse: data,
    };
  }

  /**
   * Multi-strategy premium detection that handles different RDAP
   * implementations across registries:
   *
   * 1. status[] — some registries use "premium domain" status codes
   * 2. notices[].description[] — most common (registry-specific wording)
   * 3. notices[].title[] — less common but used by some registries
   * 4. events[].eventAction[] — premium registration/transfer events
   * 5. entities[].roles[] — premium-specific entity roles
   */
  static detectPremium(data: RdapResponse): boolean {
    const patterns = [
      /^premium\b/i,
      /\bpremium\s+domain\b/i,
      /\bpremium\s+registration\b/i,
      /\bpremium\s+listing\b/i,
      /\bpremium\s+name\b/i,
      /\bpremium\s+price\b/i,
      /\bthis\s+is\s+a\s+premium\b/i,
    ];

    const test = (s: string): boolean => patterns.some((p) => p.test(s));

    if (data.status?.some((s) => test(s))) return true;

    for (const notice of data.notices ?? []) {
      if (notice.title && test(notice.title)) return true;
      if (notice.description?.some((d) => test(d))) return true;
    }

    if (data.events?.some((e) => e.eventAction && test(e.eventAction))) return true;

    const scanEntities = (entities?: RdapEntity[]): boolean => {
      if (!entities) return false;
      for (const entity of entities) {
        if (entity.roles?.some((r) => test(r))) return true;
        if (entity.entities && scanEntities(entity.entities)) return true;
      }
      return false;
    };
    if (scanEntities(data.entities)) return true;

    return false;
  }
}
