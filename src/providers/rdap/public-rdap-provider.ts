// SPDX-License-Identifier: AGPL-3.0-only
import { DomainStatus } from '../../types/domain-status.js';
import type { RdapResult } from '../../types/domain-status.js';
import { ProviderError } from '../../types/errors.js';
import type { RdapProvider } from './rdap-provider.js';
import { type RateLimiterLike, RateLimiter } from '../rate-limiter.js';
import { extractTld } from '../../utils/domain.js';
import type { RdapAgentPool } from './rdap-agent-pool.js';
import { rdapAgentPool } from './rdap-agent-pool.js';
import { rdapUrlOrigin } from './rdap-consensus-validator.js';
import {
  assertPublicHttpsUrl,
  dnsLookupWithTimeout,
  type RedirectLookup,
} from './rdap-url-guard.js';

const DEFAULT_RDAP_TIMEOUT_MS = 10_000;
export const DEFAULT_RDAP_MAX_RESPONSE_BYTES = 1_048_576;
/** Registries may legitimately redirect (RFC 7484 bootstrap hops), but a
 *  chain longer than this is treated as hostile or broken. */
const MAX_REDIRECT_HOPS = 2;

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
  readonly #maxResponseBytes: number;
  readonly #agentPool: RdapAgentPool;
  readonly #redirectLookup: RedirectLookup;
  /** TLDs this server serves authoritatively. Undefined = all TLDs
   *  (universal routing servers such as rdap.org). */
  readonly #servesTlds: Set<string> | undefined;

  constructor(
    baseUrl = 'https://rdap.org/domain/',
    name?: string,
    rateLimiter?: RateLimiterLike,
    timeoutMs = DEFAULT_RDAP_TIMEOUT_MS,
    tlds?: readonly string[],
    agentPool: RdapAgentPool = rdapAgentPool,
    maxResponseBytes = DEFAULT_RDAP_MAX_RESPONSE_BYTES,
    redirectLookup: RedirectLookup = dnsLookupWithTimeout,
  ) {
    this.#baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.name = name ?? 'PublicRdapProvider';
    this.#rateLimiter = rateLimiter ?? RateLimiter.unlimited();
    this.#timeoutMs = timeoutMs;
    this.#agentPool = agentPool;
    this.#maxResponseBytes = maxResponseBytes;
    this.#redirectLookup = redirectLookup;
    this.#servesTlds =
      tlds !== undefined ? new Set(tlds.map((t) => t.toLowerCase().replace(/^\./, ''))) : undefined;
  }

  /** True when this server can answer authoritatively for the domain's TLD. */
  servesTld(domain: string): boolean {
    if (this.#servesTlds === undefined) return true;
    return this.#servesTlds.has(extractTld(domain).replace(/^\./, ''));
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    const waitStart = Date.now();
    try {
      await this.#rateLimiter.acquire();
    } catch (err) {
      throw new ProviderError(
        `RDAP rate-limiter wait failed for ${domain}: ${String(err)}`,
        this.name,
      );
    }
    const rateLimitWaitMs = Date.now() - waitStart;

    const remainingMs = Math.max(1000, this.#timeoutMs - rateLimitWaitMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(remainingMs)])
      : AbortSignal.timeout(remainingMs);
    const result = await this.#doConfirm(domain, combinedSignal);
    // Stamp the serving origin so the 2-of-2 consensus gate can detect a
    // rubber stamp: a second opinion from the same origin is no opinion
    // (ADR-0050). Verified before caching, so the marker survives the
    // intra-run and provider caches.
    const origin = rdapUrlOrigin(this.#baseUrl);
    if (origin !== undefined && result.sourceOrigin === undefined) {
      result.sourceOrigin = origin;
    }
    return result;
  }

  async #doConfirm(domain: string, signal: AbortSignal): Promise<RdapResult> {
    const initialUrl = `${this.#baseUrl}${encodeURIComponent(domain)}`;
    let url = initialUrl;
    let response: Response;

    for (let hop = 0; ; hop++) {
      response = await this.#fetchRaw(url, signal, domain);
      if (!(response.status >= 300 && response.status < 400)) break;
      if (hop >= MAX_REDIRECT_HOPS) {
        await response.body?.cancel();
        throw new ProviderError(
          `RDAP response redirect chain exceeded ${MAX_REDIRECT_HOPS} hops for ${domain}`,
          this.name,
        );
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (location === null) break;
      const nextUrl = new URL(location, url).toString();
      try {
        await assertPublicHttpsUrl(nextUrl, this.#redirectLookup);
      } catch (err: unknown) {
        throw new ProviderError(`RDAP redirect refused for ${domain}: ${String(err)}`, this.name);
      }
      url = nextUrl;
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
      // A 404 means "not registered" ONLY when the responding server is
      // authoritative for the domain's TLD (RFC 7484). A 404 from a
      // non-authoritative server (e.g. the COM registry asked about a .io
      // name) carries no information — report Unknown so the failover
      // keeps racing instead of returning a false "Available".
      if (!this.servesTld(domain)) {
        return {
          domain,
          status: DomainStatus.Unknown,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        };
      }
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

    const data = JSON.parse(await this.#readBody(response)) as RdapResponse;
    const isPremium = PublicRdapProvider.detectPremium(data);

    return {
      domain,
      status: DomainStatus.Registered,
      isPremium,
      checkedAt: new Date().toISOString(),
      rawResponse: data,
    };
  }

  /** Fetch a single hop with redirects disabled: redirects are followed
   *  manually so each target is validated before the next request. */
  async #fetchRaw(url: string, signal: AbortSignal, domain: string): Promise<Response> {
    try {
      // The pool pairs its own fetch with the pooled dispatcher (both from
      // the same undici version): Node's global fetch rejects a dispatcher
      // from a different undici version (ADR-0049).
      return await this.#agentPool.fetchWithAgent(url, { signal, redirect: 'manual' });
    } catch (err: unknown) {
      throw new ProviderError(`RDAP request failed for ${domain}: ${String(err)}`, this.name);
    }
  }

  /** Read the response body bounded by the configured byte cap. The
   *  Content-Length header is a fast pre-check; the streamed read is the
   *  hard gate that also protects against a lying or chunked server. */
  async #readBody(response: Response): Promise<string> {
    const lengthHeader = response.headers?.get?.('content-length');
    if (lengthHeader !== undefined && lengthHeader !== null) {
      const declared = Number(lengthHeader);
      if (Number.isFinite(declared) && declared > this.#maxResponseBytes) {
        await response.body?.cancel();
        throw new ProviderError(
          `RDAP response declared ${declared} bytes, exceeding the ${this.#maxResponseBytes}-byte cap`,
          this.name,
        );
      }
    }

    const stream = response.body;
    if (stream === null || stream === undefined) {
      // Non-streaming responses (tests, exotic servers): delegate to the
      // standard body parser. json() may return a parsed object or a
      // string; round-trip both so the caller's JSON.parse always sees
      // valid JSON text.
      const parsed = await response.json().catch(() => null);
      if (parsed === null || parsed === undefined) return '';
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        received += value.byteLength;
        if (received > this.#maxResponseBytes) {
          await reader.cancel();
          throw new ProviderError(
            `RDAP response exceeded the ${this.#maxResponseBytes}-byte cap`,
            this.name,
          );
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString('utf8');
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
