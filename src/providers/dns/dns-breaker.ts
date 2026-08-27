// SPDX-License-Identifier: AGPL-3.0-only
import {
  CircuitBreaker,
  type CircuitBreakerPolicy,
  type ICircuitBreaker,
} from '../circuit-breaker.js';
import { DistributedCircuitBreaker } from '../redis/index.js';
import type { RedisClient } from '../redis/redis-client.js';
import type { DnsLookupSpec } from './dns-provider.js';

/**
 * Per-endpoint circuit breaker registry for the DNS layer (ADR-0059).
 *
 * DNS is the last provider without circuit protection: RDAP and WHOIS trip
 * on repeated failures (global + per-server, ADR-0050/ADR-0051), while a
 * dead DNS resolver kept burning the full lookup timeout on every query,
 * every run. This registry owns one circuit per resolver endpoint:
 *
 *   - `doh:<hostname>` for DoH legs (Cloudflare/Google/Quad9/…)
 *   - `dot:<endpoint>|<servername>|<port>` for DoT legs
 *   - `native:<nameservers.join(',')>` for pinned native resolvers
 *   - `native:system-resolver` for the system recursor
 *
 * The primary, secondary, and tertiary consensus providers share a single
 * registry per run composition, so a failing endpoint is skipped for every
 * leg that uses it — not just the one provider that happened to trip it.
 *
 * The breaker is a resilience optimization, not a safety gate: the
 * fail-closed Unknown path is the safety. Bookkeeping failures (Redis
 * down, registry misconfiguration) must never take DNS down — callers
 * guard every interaction and fail open (ADR-0059 Decision Drivers).
 */
export interface DnsBreakerStats {
  open: number;
  closed: number;
  halfOpen: number;
  total: number;
}

export interface DnsBreakerRegistryLike {
  allow(key: string): boolean | Promise<boolean>;
  onSuccess(key: string): void | Promise<void>;
  onFailure(key: string): void | Promise<void>;
}

/** Circuit-breaker policy for DNS endpoints (mirrors the RDAP per-server
 *  breaker default, ADR-0050). */
export const DNS_BREAKER_POLICY: CircuitBreakerPolicy = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 120_000,
};

/**
 * Stable breaker key for a resolver leg. The key must be a pure function of
 * the leg's wire identity so every provider in the composition maps the same
 * endpoint to the same circuit.
 */
export function dnsBreakerKey(spec: DnsLookupSpec, nameservers?: string[]): string {
  switch (spec.type) {
    case 'doh': {
      try {
        const hostname = new URL(spec.endpoint ?? 'https://x.invalid').hostname;
        const format = spec.format ?? 'json';
        return `doh:${hostname}:${format}`;
      } catch {
        return `doh:${spec.endpoint ?? 'unknown'}:json`;
      }
    }
    case 'dot':
      return `dot:${spec.endpoint ?? 'unknown'}|${spec.servername ?? ''}|${spec.port ?? 853}`;
    case 'native': {
      const ns = spec.nameservers ?? nameservers;
      return ns !== undefined && ns.length > 0
        ? `native:${ns.join(',')}`
        : 'native:system-resolver';
    }
  }
}

export class DnsBreakerRegistry implements DnsBreakerRegistryLike {
  readonly #policy: CircuitBreakerPolicy;
  readonly #redisClient: RedisClient | undefined;
  readonly #breakers: Map<string, ICircuitBreaker | DistributedCircuitBreaker> = new Map();

  /**
   * Optional telemetry hook: fired with the current state counts after every
   * allow/success/failure interaction (metrics feed).
   */
  onChange: ((stats: DnsBreakerStats) => void) | undefined = undefined;

  constructor(policy: Partial<CircuitBreakerPolicy> = {}, redisClient?: RedisClient) {
    this.#policy = { ...DNS_BREAKER_POLICY, ...policy };
    this.#redisClient = redisClient;
  }

  /**
   * Get (or lazily create) the circuit for an endpoint key. Exposed for
   * observability and tests; the registry itself uses it internally.
   */
  localBreaker(key: string): ICircuitBreaker {
    let breaker = this.#breakers.get(key);
    if (breaker === undefined) {
      breaker =
        this.#redisClient !== undefined
          ? new DistributedCircuitBreaker(`dns:${key}`, this.#policy, this.#redisClient)
          : new CircuitBreaker(this.#policy);
      this.#breakers.set(key, breaker);
    }
    return breaker;
  }

  async allow(key: string): Promise<boolean> {
    const allowed = await this.localBreaker(key).allow();
    this.#emitChange();
    return allowed;
  }

  async onSuccess(key: string): Promise<void> {
    await this.localBreaker(key).onSuccess();
    this.#emitChange();
  }

  async onFailure(key: string): Promise<void> {
    await this.localBreaker(key).onFailure();
    this.#emitChange();
  }

  #emitChange(): void {
    this.onChange?.(this.snapshot());
  }

  /** State counts across all consulted endpoints (metrics/tests). */
  snapshot(): DnsBreakerStats {
    let open = 0;
    let closed = 0;
    let halfOpen = 0;
    for (const breaker of this.#breakers.values()) {
      switch (breaker.state) {
        case 'open':
          open++;
          break;
        case 'half-open':
          halfOpen++;
          break;
        default:
          closed++;
      }
    }
    return { open, closed, halfOpen, total: this.#breakers.size };
  }

  /** Drop all circuits (shutdown path). */
  reset(): void {
    for (const breaker of this.#breakers.values()) {
      (breaker as ICircuitBreaker & { reset(): void }).reset();
    }
    this.#breakers.clear();
  }
}
