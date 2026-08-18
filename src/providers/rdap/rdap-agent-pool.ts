// SPDX-License-Identifier: AGPL-3.0-only
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit } from 'undici';

export interface RdapAgentPoolOptions {
  /** Max keep-alive sockets per origin (default: 32). */
  maxConnections?: number;
  /**
   * Injectable agent factory for tests. Defaults to undici `Agent`, which is
   * origin-aware internally: a single Agent owns a connection pool per origin
   * with `connections` max sockets each, queueing excess requests.
   */
  agentFactory?: (options: { connections: number }) => Dispatcher;
  /**
   * Injectable wire fetch for tests. Defaults to undici's own `fetch` so the
   * dispatcher and the fetch implementation always come from the same undici
   * version: Node's global fetch (bundled undici) rejects a dispatcher from a
   * different undici version with "invalid onRequestStart method".
   */
  fetchFn?: typeof fetch;
}

/**
 * Pool of undici dispatchers for RDAP transport (ADR-0049).
 *
 * Without this, every RDAP query issues `fetch` through the global (one-shot)
 * dispatcher: each query opens its own TLS + HTTP handshake, and the per-origin
 * connection budget is the undici default. A bulk pipeline run
 * (RDAP_BATCH_CONCURRENCY) plus watchlist and portfolio checks pays that
 * handshake cost per query against Verisign, ccTLD registries and rdap.org.
 *
 * The pool holds a single undici `Agent` shared by every RDAP endpoint.
 * undici Agents are origin-aware: one Agent owns a connection pool per origin
 * with `connections` max sockets each, reusing keep-alive connections and
 * queueing excess load instead of multiplying handshakes. Lazy creation keeps
 * idle deployments connection-free. A caller should not hold its own Agent:
 * `getDispatcher()` returns the shared, stable instance so
 * `fetch(url, { dispatcher })` reuses warm connections.
 */
export class RdapAgentPool {
  readonly #maxConnections: number;
  readonly #agentFactory: (options: { connections: number }) => Dispatcher;
  readonly #fetchFn: typeof fetch | undefined;
  #agent: Dispatcher | undefined;
  #disposed = false;

  constructor(options: RdapAgentPoolOptions = {}) {
    this.#maxConnections = options.maxConnections ?? 32;
    this.#agent = undefined;
    this.#agentFactory =
      options.agentFactory ?? (({ connections }): Dispatcher => new Agent({ connections }));
    this.#fetchFn = options.fetchFn;
    this.#disposed = false;
  }

  /**
   * Returns the shared undici dispatcher for the pool. Creates it lazily so
   * idle deployments do not hold connections; called by the provider on the
   * hot path (per domain query).
   */
  async getDispatcher(): Promise<Dispatcher> {
    if (this.#disposed) throw new Error('RdapAgentPool: agent pool is disposed');
    this.#agent ??= this.#agentFactory({ connections: this.#maxConnections });
    return this.#agent;
  }

  /**
   * Fetch through the pooled Agent, using a fetch implementation that matches
   * the Agent's undici version (the injected fetchFn or undici's own fetch).
   * Callers must never hand a pooled dispatcher to Node's global fetch: the
   * two undici versions disagree on request handlers.
   */
  async fetchWithAgent(
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' },
  ): Promise<Response> {
    const dispatcher = await this.getDispatcher();
    // Normalized signature: the injected fetchFn (DOM-style fetch types) and
    // undici's own fetch disagree on RequestInit — the subset we pass
    // (headers/signal/redirect/dispatcher) is shared, so one concrete
    // signature.
    const wireFetch: (url: string, init?: RequestInit) => Promise<Response> = (this.#fetchFn ??
      undiciFetch) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    return wireFetch(url, { ...(init ?? {}), dispatcher } as RequestInit);
  }

  /** Releases all sockets. Idempotent — safe to call multiple times. */
  close(): void {
    if (this.#disposed) return;
    if (this.#agent !== undefined) {
      try {
        void this.#agent.close();
      } catch {
        // close() may throw when a request is in flight; pool is already
        // effectively disposed either way.
      }
    }
    this.#disposed = true;
  }
}

/** Process-wide shared pool used by default across RDAP providers. */
export const rdapAgentPool = new RdapAgentPool();
