import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeDnsProvider } from '../node-dns-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';

vi.mock('node:dns', () => ({
  promises: {
    resolve: vi.fn(),
  },
}));

import { promises as dnsPromises } from 'node:dns';

function makeResolved(): never {
  return ['1.2.3.4'] as never;
}

describe('NodeDnsProvider', () => {
  let provider: NodeDnsProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new NodeDnsProvider({ cacheTtlMs: 60_000 });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns Registered when DNS resolves', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const result = await provider.checkAvailability('taken.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.domain).toBe('taken.com');
  });

  it('returns Available on ENOTFOUND', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
    const result = await provider.checkAvailability('free-domain-xyz-123.com');
    expect(result.status).toBe(DomainStatus.Available);
  });

  it('returns Available on ENODATA', async () => {
    const err = Object.assign(new Error('no data'), { code: 'ENODATA' });
    vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
    const result = await provider.checkAvailability('no-records.com');
    expect(result.status).toBe(DomainStatus.Available);
  });

  it('returns Unknown on unexpected error', async () => {
    const err = Object.assign(new Error('network'), { code: 'ETIMEOUT' });
    vi.mocked(dnsPromises.resolve).mockRejectedValue(err);
    const result = await provider.checkAvailability('example.com');
    expect(result.status).toBe(DomainStatus.Unknown);
  });

  it('checkBulk returns results for all domains', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const results = await provider.checkBulk(['a.com', 'b.com', 'c.com']);
    expect(results).toHaveLength(3);
  });

  it('returns cached result on repeated check without DNS lookup', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('cached.com');

    vi.mocked(dnsPromises.resolve).mockClear();

    const result = await provider.checkAvailability('cached.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(dnsPromises.resolve).not.toHaveBeenCalled();
  });

  it('expires cache entry after TTL and performs fresh lookup', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('expire.com');

    vi.advanceTimersByTime(60_001);
    vi.mocked(dnsPromises.resolve).mockClear();

    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const result = await provider.checkAvailability('expire.com');
    expect(dnsPromises.resolve).toHaveBeenCalled();
    expect(result.status).toBe(DomainStatus.Registered);
  });

  it('pruneCache removes expired entries', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('stale.com');

    vi.advanceTimersByTime(60_001);
    const pruned = provider.pruneCache();

    expect(pruned).toBe(1);
  });

  it('clearCache removes all entries', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    await provider.checkAvailability('clear.com');

    vi.mocked(dnsPromises.resolve).mockClear();

    provider.clearCache();
    await provider.checkAvailability('clear.com');
    expect(dnsPromises.resolve).toHaveBeenCalled();
  });

  it('checkAvailability rejects when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(provider.checkAvailability('aborted.com', ac.signal)).rejects.toThrow('Aborted');
  });
});
