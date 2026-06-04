import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeDnsProvider } from '../node-dns-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';

vi.mock('node:dns', () => ({
  promises: {
    resolve: vi.fn(),
  },
}));

import { promises as dnsPromises } from 'node:dns';

describe('NodeDnsProvider', () => {
  let provider: NodeDnsProvider;

  beforeEach(() => {
    provider = new NodeDnsProvider();
    vi.clearAllMocks();
  });

  it('returns Registered when DNS resolves', async () => {
    vi.mocked(dnsPromises.resolve).mockResolvedValue(['1.2.3.4'] as never);
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
    vi.mocked(dnsPromises.resolve).mockResolvedValue(['1.2.3.4'] as never);
    const results = await provider.checkBulk(['a.com', 'b.com', 'c.com']);
    expect(results).toHaveLength(3);
  });
});
