// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../../logger.js';
import { fetch as undiciFetch, type Dispatcher, type RequestInit } from 'undici';

export interface RdapBootstrapServer {
  /** Human-readable server name (hostname). */
  name: string;
  /** Base URL — the domain name is appended verbatim. */
  baseUrl: string;
  /** TLDs this server serves authoritatively (empty = all TLDs). */
  tlds: string[];
}

export const IANA_RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

/** rdap.org routes any domain to the correct registry — universal fallback. */
export const RDAP_ORG_UNIVERSAL: RdapBootstrapServer = {
  name: 'rdap.org',
  baseUrl: 'https://rdap.org/',
  tlds: [],
};

const BOOTSTRAP_FETCH_TIMEOUT_MS = 10_000;
/** How long a hot-path query waits for an in-flight bootstrap refresh
 * (cold start, warm-up) before degrading to rdap.org routing. The full
 * fetch must never stall a domain query for its 10s timeout. */
const BOOTSTRAP_INFLIGHT_BUDGET_MS = 1_000;

/**
 * Observable state of the IANA bootstrap (ADR-0058). Emitted to status
 * subscribers after every fetch attempt and served by getStatus() for
 * health/metrics surfaces.
 */
export interface BootstrapStatus {
  /** True when the last fetch attempt succeeded. */
  ok: boolean;
  /** Consecutive failed fetch attempts (resets on success). */
  consecutiveFailures: number;
  /** ISO timestamp of the last successful fetch, or null. */
  lastSuccessAt: string | null;
  /** Epoch ms after which the next fetch attempt is allowed, or null. */
  nextRetryAt: number | null;
  /** Message of the last fetch failure, or null. */
  lastError: string | null;
}

export interface IanaRdapBootstrapOptions {
  /** Injectable fetch implementation (defaults to globalThis.fetch, resolved
   *  at call time so tests can swap the global mock mid-flight). */
  fetchFn?: typeof fetch;
  /** Supplies the shared undici dispatcher (ADR-0049) so the bootstrap
   *  fetch reuses the keep-alive pool instead of a one-shot connection. */
  getDispatcher?: () => Promise<Dispatcher>;
  /** Exponential backoff base for failed refresh attempts (ADR-0058).
   *  Default: 5 minutes. */
  retryBaseMs?: number;
  /** Cap for the exponential backoff (ADR-0058). Default: 24 hours. */
  retryMaxMs?: number;
}

interface IanaService {
  ldhName?: string[];
  urls?: string[];
}

interface IanaDnsBootstrap {
  services?: IanaService[];
}

/**
 * IANA RDAP bootstrap resolver (RFC 7484).
 *
 * Maps a TLD to the registry's authoritative RDAP base URLs. A 404 from an
 * authoritative registry server means "not registered"; a 404 from any
 * other server means nothing. Selecting the authoritative server per TLD is
 * therefore a correctness requirement, not an optimisation.
 *
 * Degrades gracefully: an unknown TLD or a failed fetch resolves to
 * rdap.org (a routing service that can answer any TLD) and never throws.
 *
 * A failed refresh is retried with exponential backoff (ADR-0058) instead
 * of waiting a full TTL: the schedule is `base * 2^(failures-1)` capped at
 * `retryMaxMs`, and previously loaded servers keep being served during the
 * backoff window.
 */
export class IanaRdapBootstrap {
  readonly #url: string;
  readonly #ttlMs: number;
  readonly #fetchFn: typeof fetch | undefined;
  readonly #getDispatcher: (() => Promise<Dispatcher>) | undefined;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  #cache = new Map<string, RdapBootstrapServer[]>();
  #lastSuccessAt = 0;
  #nextRetryAt = 0;
  #consecutiveFailures = 0;
  #lastError: string | null = null;
  #statusListeners = new Set<(status: BootstrapStatus) => void>();
  #inFlight: Promise<void> | null = null;

  constructor(
    url: string = IANA_RDAP_BOOTSTRAP_URL,
    ttlMs: number = 24 * 60 * 60 * 1000,
    options: IanaRdapBootstrapOptions = {},
  ) {
    this.#url = url;
    this.#ttlMs = ttlMs;
    this.#fetchFn = options.fetchFn;
    this.#getDispatcher = options.getDispatcher;
    this.#retryBaseMs = options.retryBaseMs ?? 5 * 60 * 1000;
    this.#retryMaxMs = options.retryMaxMs ?? 24 * 60 * 60 * 1000;
  }

  /** Current observable state (ADR-0058) for health and metrics surfaces. */
  getStatus(): BootstrapStatus {
    return {
      ok: this.#consecutiveFailures === 0,
      consecutiveFailures: this.#consecutiveFailures,
      lastSuccessAt: this.#lastSuccessAt > 0 ? new Date(this.#lastSuccessAt).toISOString() : null,
      nextRetryAt: this.#nextRetryAt > 0 ? this.#nextRetryAt : null,
      lastError: this.#lastError,
    };
  }

  /**
   * Subscribe to fetch-attempt outcomes. The listener is invoked after every
   * attempt (success or failure) with the current status. Returns an
   * unsubscribe function.
   */
  subscribeStatus(listener: (status: BootstrapStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /**
   * Resolve authoritative RDAP servers for a TLD (with or without the
   * leading dot). Always includes the rdap.org fallback, deduplicated.
   */
  async getServers(tld: string): Promise<RdapBootstrapServer[]> {
    const key = tld.toLowerCase().replace(/^\./, '');
    await this.#refreshIfStale();
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return [
        ...cached,
        ...(cached.some((s) => s.baseUrl === RDAP_ORG_UNIVERSAL.baseUrl)
          ? []
          : [RDAP_ORG_UNIVERSAL]),
      ];
    }
    // Unknown TLD or unavailable bootstrap: rdap.org routes everything.
    return [RDAP_ORG_UNIVERSAL];
  }

  /** Force a fresh fetch of the bootstrap data. */
  async refresh(): Promise<void> {
    if (this.#inFlight) {
      await this.#inFlight;
      return;
    }
    this.#inFlight = this.#fetch();
    try {
      await this.#inFlight;
    } finally {
      this.#inFlight = null;
    }
  }

  /**
   * Start a background refresh of the bootstrap data (fire-and-forget).
   * Call once at process startup so the first RDAP query of the process
   * does not stall on a cold fetch. Failures are logged by refresh() and
   * never thrown.
   */
  warm(): void {
    void this.refresh();
  }

  async #refreshIfStale(): Promise<void> {
    // Fresh data: nothing to do.
    if (this.#lastSuccessAt !== 0 && Date.now() - this.#lastSuccessAt < this.#ttlMs) return;
    // Inside the backoff window after a failure: keep serving what we have
    // (stale cache or the rdap.org fallback) instead of hammering IANA.
    if (Date.now() < this.#nextRetryAt) return;
    if (this.#inFlight) {
      // A refresh is already running (e.g. the startup warm-up). Wait only
      // a short budget before serving the rdap.org fallback — a domain
      // query must never wait the full fetch timeout.
      await Promise.race([
        this.#inFlight,
        new Promise<void>((resolve) => setTimeout(resolve, BOOTSTRAP_INFLIGHT_BUDGET_MS)),
      ]);
      return;
    }
    await this.refresh();
  }

  async #fetch(): Promise<void> {
    try {
      const dispatcher =
        this.#getDispatcher !== undefined ? await this.#getDispatcher() : undefined;
      // dispatcher is typed unknown to bridge undici vs undici-types (same
      // approach as the public RDAP provider, ADR-0049).
      const init: { signal: AbortSignal; dispatcher?: unknown } = {
        signal: AbortSignal.timeout(BOOTSTRAP_FETCH_TIMEOUT_MS),
      };
      if (dispatcher !== undefined) {
        init.dispatcher = dispatcher;
      }
      // When a pooled dispatcher is attached, the wire fetch must come from
      // the same undici version (undici's own fetch): Node's global fetch
      // rejects a foreign dispatcher with "invalid onRequestStart method".
      // An explicit fetchFn (tests) always wins; without a dispatcher the
      // global fetch is fine.
      const wireFetch: (url: string, init?: RequestInit) => Promise<Response> = (this.#fetchFn ??
        (dispatcher !== undefined ? undiciFetch : globalThis.fetch)) as unknown as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>;
      const response = await wireFetch(this.#url, init as RequestInit);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as IanaDnsBootstrap;
      const byTld = new Map<string, RdapBootstrapServer[]>();
      for (const service of data.services ?? []) {
        const urls = service.urls ?? [];
        if (urls.length === 0) continue;
        for (const rawTld of service.ldhName ?? []) {
          const tld = rawTld.replace(/^\./, '').toLowerCase();
          const servers = urls.map((url) => toServer(url, tld));
          byTld.set(tld, [...(byTld.get(tld) ?? []), ...servers]);
        }
      }
      this.#cache = byTld;
      this.#lastSuccessAt = Date.now();
      this.#consecutiveFailures = 0;
      this.#nextRetryAt = 0;
      this.#lastError = null;
      getLogger().info(
        { tlds: this.#cache.size },
        'RDAP bootstrap refreshed from IANA registry data',
      );
    } catch (err) {
      // Schedule the next attempt with exponential backoff (ADR-0058):
      // base * 2^(failures-1), capped at retryMaxMs. Previously loaded
      // servers remain in the cache and keep being served meanwhile.
      this.#consecutiveFailures++;
      const delay = Math.min(
        this.#retryMaxMs,
        this.#retryBaseMs * 2 ** (this.#consecutiveFailures - 1),
      );
      this.#nextRetryAt = Date.now() + delay;
      this.#lastError = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { err, retryInMs: delay },
        'RDAP bootstrap fetch failed — falling back to rdap.org routing',
      );
    } finally {
      this.#emitStatus();
    }
  }

  #emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.#statusListeners) {
      try {
        listener(status);
      } catch (err) {
        getLogger().warn(
          { err: err instanceof Error ? err.message : String(err) },
          'RDAP bootstrap status listener threw',
        );
      }
    }
  }
}

/** Convert an IANA base URL into a server descriptor with a stable name. */
function toServer(url: string, tld: string): RdapBootstrapServer {
  const baseUrl = url.endsWith('/') ? url : `${url}/`;
  let name = 'iana-rdap';
  try {
    name = new URL(baseUrl).hostname;
  } catch {
    // Non-URL input from the bootstrap is ignored upstream; keep a stable name.
  }
  return { name, baseUrl, tlds: [tld] };
}
