// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../../logger.js';

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
 */
export class IanaRdapBootstrap {
  readonly #url: string;
  readonly #ttlMs: number;
  #cache = new Map<string, RdapBootstrapServer[]>();
  #fetchedAt = 0;
  #inFlight: Promise<void> | null = null;

  constructor(url: string = IANA_RDAP_BOOTSTRAP_URL, ttlMs: number = 24 * 60 * 60 * 1000) {
    this.#url = url;
    this.#ttlMs = ttlMs;
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
    if (Date.now() - this.#fetchedAt < this.#ttlMs) return;
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
      const response = await fetch(this.#url, {
        signal: AbortSignal.timeout(BOOTSTRAP_FETCH_TIMEOUT_MS),
      });
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
      this.#fetchedAt = Date.now();
      getLogger().info(
        { tlds: this.#cache.size },
        'RDAP bootstrap refreshed from IANA registry data',
      );
    } catch (err) {
      // Mark fetched so we retry only after the TTL, not on every call.
      this.#fetchedAt = Date.now();
      getLogger().warn({ err }, 'RDAP bootstrap fetch failed — falling back to rdap.org routing');
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
