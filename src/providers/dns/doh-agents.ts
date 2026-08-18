// SPDX-License-Identifier: AGPL-3.0-only
import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit } from 'undici';

export interface DohAgentPoolOptions {
  /** Max keep-alive sockets per DoH origin (default: 64). */
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
 * Pool of undici dispatchers for DNS-over-HTTPS (ADR-0044).
 *
 * Without this, every DoH lookup issues `fetch` through the global (one-shot)
 * dispatcher: each query opens its own TLS + HTTP handshake, and the per-origin
 * connection budget is the undici default. A bulk pipeline firing hundreds of
 * DoH checks pays that handshake cost per query.
 *
 * The pool holds a single undici `Agent` shared by every DoH endpoint in the
 * provider. undici Agents are origin-aware: one Agent owns a connection pool
 * per origin with `connections` max sockets each, reusing keep-alive
 * connections and queueing excess load instead of multiplying handshakes.
 * Lazy creation keeps idle deployments connection-free. A caller should not
 * hold its own Agent: `dispatcherFor(endpoint)` returns the shared, stable
 * instance so `fetch(url, { dispatcher })` reuses warm connections.
 */
export class DohAgentPool {
  readonly #maxConnections: number;
  readonly #agentFactory: (options: { connections: number }) => Dispatcher;
  readonly #fetchFn: typeof fetch | undefined;
  #agent: Dispatcher | undefined;
  #disposed = false;

  constructor(options: DohAgentPoolOptions = {}) {
    this.#maxConnections = options.maxConnections ?? 64;
    this.#agentFactory = options.agentFactory ?? ((opts): Dispatcher => new Agent(opts));
    this.#fetchFn = options.fetchFn;
  }

  /**
   * Return the shared undici Agent for DoH requests, creating it on first use.
   * The `endpoint` is ignored for dispatch (the Agent is origin-aware); it is
   * kept in the signature so doh service calls read as "give me the dispatcher
   * for this origin".
   */
  dispatcherFor(_endpoint: string): Dispatcher {
    if (this.#agent === undefined) {
      this.#agent = this.#agentFactory({ connections: this.#maxConnections });
    }
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
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<Response> {
    // Normalized signature: the injected fetchFn (DOM-style fetch types) and
    // undici's own fetch disagree on RequestInit — the subset we pass
    // (headers/signal/dispatcher) is shared, so one concrete signature.
    const wireFetch: (url: string, init?: RequestInit) => Promise<Response> = (this.#fetchFn ??
      undiciFetch) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    return wireFetch(url, {
      ...(init ?? {}),
      dispatcher: this.dispatcherFor(url),
    } as RequestInit);
  }

  /**
   * Close the pooled Agent and drop it. Idempotent: safe to call on shutdown
   * or on a pool that was never used. Pending queries fail fast. A subsequent
   * dispatcherFor() lazily creates a fresh Agent (the provider remains usable
   * across dispose for its callers).
   */
  dispose(): void {
    if (this.#disposed && this.#agent === undefined) return;
    const agent = this.#agent;
    this.#agent = undefined;
    if (agent !== undefined) {
      void agent.destroy?.();
    }
    this.#disposed = true;
  }

  /** 1 when a shared Agent has been created, 0 otherwise (metrics/tests). */
  get size(): number {
    return this.#agent === undefined ? 0 : 1;
  }
}
