// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeDnsProvider } from '../node-dns-provider.js';
import { DnsBreakerRegistry, type DnsBreakerRegistryLike } from '../dns-breaker.js';
import { DomainStatus } from '../../../types/domain-status.js';

vi.mock('node:dns', () => {
  const resolveFn = vi.fn();
  return {
    promises: {
      resolve: resolveFn,
    },
  };
});

import { promises as dnsPromises } from 'node:dns';

function makeResolved(): never {
  return ['1.2.3.4'] as never;
}

function makeTimeoutError(): Error & { code: string } {
  return Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
}

describe('NodeDnsProvider circuit breaker integration (ADR-0059)', () => {
  let provider: NodeDnsProvider;
  let breakers: DnsBreakerRegistry;

  beforeEach(() => {
    breakers = new DnsBreakerRegistry({
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    provider = new NodeDnsProvider({ lookupStrategy: 'native', breakers });
    vi.clearAllMocks();
  });

  afterEach(() => {
    provider.dispose();
  });

  it('skips an open-circuit leg without issuing further wire queries', async () => {
    vi.mocked(dnsPromises.resolve).mockRejectedValue(makeTimeoutError());

    // Two failures trip the native system-resolver circuit.
    const first = await provider.checkAvailability('fail-one.com');
    expect(first.status).toBe(DomainStatus.Unknown);
    const second = await provider.checkAvailability('fail-two.com');
    expect(second.status).toBe(DomainStatus.Unknown);
    await expect(breakers.allow('native:system-resolver')).resolves.toBe(false);

    // The circuit is open: the next lookup must not touch the resolver at all.
    vi.mocked(dnsPromises.resolve).mockClear();
    const third = await provider.checkAvailability('fail-three.com');
    expect(third.status).toBe(DomainStatus.Unknown);
    expect(dnsPromises.resolve).not.toHaveBeenCalled();
  });

  it('does not trip the breaker on caller-initiated aborts (ADR-0058)', async () => {
    breakers = new DnsBreakerRegistry({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    provider = new NodeDnsProvider({ lookupStrategy: 'native', breakers });

    const neverResolves = new Promise<never>(() => {});
    vi.mocked(dnsPromises.resolve).mockReturnValue(neverResolves as never);

    // Entry-level pre-abort checks fail fast (ADR-0044): an already-aborted
    // caller signal throws before any wire query, so no resolver interaction
    // is recorded against the circuit. (The shared lookup deliberately does
    // not observe a mid-flight caller abort on its wire queries, so the
    // entry check is the cancellation seam that must stay breaker-neutral.)
    for (const domain of ['abort-one.com', 'abort-two.com']) {
      const controller = new AbortController();
      controller.abort();
      await expect(provider.checkAvailability(domain, controller.signal)).rejects.toThrow();
    }
    expect(dnsPromises.resolve).not.toHaveBeenCalled();

    // Threshold is 1: had the aborts been recorded as failures, the very
    // first one would have tripped the circuit. It must still be closed.
    await expect(breakers.allow('native:system-resolver')).resolves.toBe(true);
  });

  it('closes the circuit when a half-open probe succeeds', async () => {
    breakers = new DnsBreakerRegistry({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 50,
    });
    provider = new NodeDnsProvider({ lookupStrategy: 'native', breakers });

    vi.mocked(dnsPromises.resolve).mockRejectedValue(makeTimeoutError());
    await provider.checkAvailability('trip.com');
    await expect(breakers.allow('native:system-resolver')).resolves.toBe(false);

    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await provider.checkAvailability('recovers.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(breakers.snapshot().open).toBe(0);
    await expect(breakers.allow('native:system-resolver')).resolves.toBe(true);
  });

  it('keeps serving verdicts when breaker bookkeeping itself fails (fail-open)', async () => {
    const throwingBreakers: DnsBreakerRegistryLike = {
      allow: () => {
        throw new Error('redis unreachable');
      },
      onSuccess: () => {
        throw new Error('redis unreachable');
      },
      onFailure: () => {
        throw new Error('redis unreachable');
      },
    };
    const p = new NodeDnsProvider({ lookupStrategy: 'native', breakers: throwingBreakers });

    vi.mocked(dnsPromises.resolve).mockRejectedValue(makeTimeoutError());
    const result = await p.checkAvailability('breaker-down.com');
    expect(result.status).toBe(DomainStatus.Unknown);
    p.dispose();
  });

  it('keeps one breaker per endpoint inside a resolver group', async () => {
    const p = new NodeDnsProvider({ lookupStrategy: 'doh-only', breakers });
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    await p.checkAvailability('doh-one.com');
    await p.checkAvailability('doh-two.com');

    // The default DoH group races three endpoints; each endpoint must carry
    // its own circuit, so one dead provider cannot drag the others open.
    const snapshot = breakers.snapshot();
    expect(snapshot.total).toBeGreaterThanOrEqual(2);
    expect(snapshot.open).toBeGreaterThanOrEqual(1);
    p.dispose();
  });
});
