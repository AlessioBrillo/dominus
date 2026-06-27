import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeDnsProvider } from '../node-dns-provider.js';
import { ParkingIpRegistry, type ParkingRange } from '../parking-ip-registry.js';
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

const PARKING_RANGES: ParkingRange[] = [
  {
    name: 'GoDaddy',
    cidr: ['208.109.0.0/16', '64.202.0.0/16'],
  },
  {
    name: 'TestPark',
    cidr: ['1.2.3.0/24'],
  },
];

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

  it('returns isParked=true when domain resolves to a known parking IP', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const parkingRegistry = new ParkingIpRegistry(PARKING_RANGES);
    const p = new NodeDnsProvider({
      cacheTtlMs: 60_000,
      parkingEnabled: true,
      parkingRegistry,
    });
    const result = await p.checkAvailability('parked.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isParked).toBe(true);
    expect(result.parkingRegistrar).toBe('TestPark');
  });

  it('does not set isParked when parking is disabled', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(makeResolved());
    const parkingRegistry = new ParkingIpRegistry(PARKING_RANGES);
    const p = new NodeDnsProvider({
      cacheTtlMs: 60_000,
      parkingEnabled: false,
      parkingRegistry,
    });
    const result = await p.checkAvailability('parked.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isParked).toBeUndefined();
  });

  it('returns isParked=false when domain resolves but IP is not a parking range', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(['9.9.9.9'] as never);
    const parkingRegistry = new ParkingIpRegistry(PARKING_RANGES);
    const p = new NodeDnsProvider({
      cacheTtlMs: 60_000,
      parkingEnabled: true,
      parkingRegistry,
    });
    const result = await p.checkAvailability('active-site.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isParked).toBeUndefined();
  });
});
