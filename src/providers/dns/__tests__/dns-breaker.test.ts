// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { DnsBreakerRegistry, dnsBreakerKey } from '../dns-breaker.js';

describe('dnsBreakerKey (ADR-0059)', () => {
  it('keys DoH legs by endpoint hostname', () => {
    expect(
      dnsBreakerKey(
        { type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query', format: 'json' },
        undefined,
      ),
    ).toBe('doh:cloudflare-dns.com');
  });

  it('keys DoH wire legs by endpoint hostname', () => {
    expect(
      dnsBreakerKey(
        { type: 'doh', endpoint: 'https://dns.quad9.net/dns-query', format: 'wire' },
        undefined,
      ),
    ).toBe('doh:dns.quad9.net');
  });

  it('keys DoT legs by endpoint|servername|port', () => {
    expect(
      dnsBreakerKey(
        { type: 'dot', endpoint: '1.1.1.1', servername: 'cloudflare-dns.com', port: 853 },
        undefined,
      ),
    ).toBe('dot:1.1.1.1|cloudflare-dns.com|853');
  });

  it('keys native legs by their nameserver set', () => {
    expect(dnsBreakerKey({ type: 'native', nameservers: ['127.0.0.1', '10.0.0.1'] }, undefined)).toBe(
      'native:127.0.0.1,10.0.0.1',
    );
  });

  it('keys unconfigured native legs as the system resolver', () => {
    expect(dnsBreakerKey({ type: 'native' }, undefined)).toBe('native:system-resolver');
  });
});

describe('DnsBreakerRegistry (ADR-0059)', () => {
  it('allows queries while closed', () => {
    const registry = new DnsBreakerRegistry({ failureThreshold: 2, windowMs: 1000, cooldownMs: 1000 });
    expect(registry.allow('doh:cloudflare-dns.com')).resolves.toBe(true);
  });

  it('opens after the failure threshold and blocks further queries', () => {
    const registry = new DnsBreakerRegistry({
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    const key = 'dot:1.1.1.1|cloudflare-dns.com|853';
    void registry.allow(key);
    void registry.onFailure(key);
    void registry.onFailure(key);
    expect(registry.allow(key)).resolves.toBe(false);
  });

  it('recovers to half-open after the cooldown and closes on success', async () => {
    const registry = new DnsBreakerRegistry({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 50,
    });
    const key = 'native:127.0.0.1';
    await registry.onFailure(key);
    expect(await registry.allow(key)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await registry.allow(key)).toBe(true);
    await registry.onSuccess(key);
    expect(await registry.allow(key)).toBe(true);
  });

  it('re-opens when a half-open probe fails', async () => {
    const registry = new DnsBreakerRegistry({
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 50,
    });
    const key = 'doh:cloudflare-dns.com';
    await registry.onFailure(key);
    await registry.onFailure(key);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await registry.allow(key)).toBe(true);
    await registry.onFailure(key);
    expect(await registry.allow(key)).toBe(false);
  });

  it('keeps endpoints independent — one open circuit does not block others', async () => {
    const registry = new DnsBreakerRegistry({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    await registry.onFailure('doh:a.com');
    expect(await registry.allow('doh:b.com')).toBe(true);
  });

  it('reports state counts through snapshot', async () => {
    const registry = new DnsBreakerRegistry({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    await registry.allow('doh:a.com');
    await registry.onFailure('doh:a.com');
    await registry.allow('doh:b.com');
    const snapshot = registry.snapshot();
    expect(snapshot.total).toBe(2);
    expect(snapshot.open).toBe(1);
    expect(snapshot.closed).toBe(1);
    expect(snapshot.halfOpen).toBe(0);
  });

  it('shares one breaker per endpoint key across callers', async () => {
    const registry = new DnsBreakerRegistry({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    const key = 'native:system-resolver';
    await registry.onFailure(key);
    expect(await registry.allow(key)).toBe(false);
    expect(registry.snapshot().total).toBe(1);
  });
});