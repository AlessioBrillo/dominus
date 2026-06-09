import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicRdapProvider } from '../public-rdap-provider.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { ProviderError } from '../../../types/errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PublicRdapProvider', () => {
  let provider: PublicRdapProvider;

  beforeEach(() => {
    provider = new PublicRdapProvider();
    vi.clearAllMocks();
  });

  it('returns Available on 404', async () => {
    mockFetch.mockResolvedValue({ status: 404, ok: false });
    const result = await provider.confirm('free-domain.com');
    expect(result.status).toBe(DomainStatus.Available);
    expect(result.isPremium).toBe(false);
  });

  it('returns Registered on 200 without premium notice', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ ldhName: 'example.com', status: ['active'] }),
    });
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isPremium).toBe(false);
  });

  it('detects premium from RDAP notices', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          ldhName: 'premium.com',
          notices: [{ description: ['This is a Premium domain name.'] }],
        }),
    });
    const result = await provider.confirm('premium.com');
    expect(result.isPremium).toBe(true);
  });

  it('throws ProviderError on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(provider.confirm('example.com')).rejects.toBeInstanceOf(ProviderError);
  });

  it('returns Unknown on unexpected non-404 error status', async () => {
    mockFetch.mockResolvedValue({ status: 503, ok: false });
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Unknown);
  });

  it('handles notices with missing description gracefully', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          ldhName: 'example.com',
          status: ['active'],
          notices: [{ description: ['Regular text'] }, { otherField: 'value' }],
        }),
    });
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(result.isPremium).toBe(false);
  });
});
