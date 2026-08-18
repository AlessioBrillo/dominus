// SPDX-License-Identifier: AGPL-3.0-only
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

  it('returns Unknown on 404 when the server is not authoritative for the TLD', async () => {
    // A COM registry asked about a .io domain — the 404 is meaningless.
    const comOnly = new PublicRdapProvider(
      'https://rdap.verisign.com/com/v1/domain/',
      'verisign-com',
      undefined,
      undefined,
      ['com'],
    );
    mockFetch.mockResolvedValue({ status: 404, ok: false });
    const result = await comOnly.confirm('free-domain.io');
    expect(result.status).toBe(DomainStatus.Unknown);
  });

  it('returns Available on 404 when the server IS authoritative for the TLD', async () => {
    const comOnly = new PublicRdapProvider(
      'https://rdap.verisign.com/com/v1/domain/',
      'verisign-com',
      undefined,
      undefined,
      ['com'],
    );
    mockFetch.mockResolvedValue({ status: 404, ok: false });
    const result = await comOnly.confirm('free-domain.com');
    expect(result.status).toBe(DomainStatus.Available);
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

  it('detects premium from RDAP status array', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          ldhName: 'premium-status.com',
          status: ['premium domain', 'active'],
        }),
    });
    const result = await provider.confirm('premium-status.com');
    expect(result.isPremium).toBe(true);
  });

  it('detects premium from RDAP events', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          ldhName: 'premium-event.com',
          status: ['active'],
          events: [{ eventAction: 'premium registration', eventDate: '2024-01-01' }],
        }),
    });
    const result = await provider.confirm('premium-event.com');
    expect(result.isPremium).toBe(true);
  });

  it('detects premium from entity roles', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          ldhName: 'premium-entity.com',
          status: ['active'],
          entities: [{ handle: 'PREMIUM-1', roles: ['premium holder'] }],
        }),
    });
    const result = await provider.confirm('premium-entity.com');
    expect(result.isPremium).toBe(true);
  });

  it('detects premium from nested entities', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          ldhName: 'nested-premium.com',
          status: ['active'],
          entities: [
            {
              handle: 'REG-1',
              roles: ['registrar'],
              entities: [{ handle: 'PREMIUM-1', roles: ['premium holder'] }],
            },
          ],
        }),
    });
    const result = await provider.confirm('nested-premium.com');
    expect(result.isPremium).toBe(true);
  });

  it('detects premium from notice title', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          ldhName: 'title-premium.com',
          status: ['active'],
          notices: [{ title: 'Premium Domain', description: ['Additional info'] }],
        }),
    });
    const result = await provider.confirm('title-premium.com');
    expect(result.isPremium).toBe(true);
  });
});

describe('PublicRdapProvider HTTP hardening', () => {
  let provider: PublicRdapProvider;
  const publicLookup = async (): Promise<string[]> => ['93.184.216.34'];
  const redirectBody = { cancel: vi.fn() };

  beforeEach(() => {
    provider = new PublicRdapProvider(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publicLookup,
    );
    vi.clearAllMocks();
  });

  it('follows a single redirect to a public HTTPS origin and cancels the interim body', async () => {
    mockFetch
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: {
          get: (name: string): string | null =>
            name === 'location' ? 'https://registry2.example/domain/example.com' : null,
        },
        body: redirectBody,
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ ldhName: 'example.com', status: ['active'] }),
      });
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Registered);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(redirectBody.cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a private IP target', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: { get: () => 'https://192.168.1.10/domain/example.com' },
      body: redirectBody,
    });
    await expect(provider.confirm('example.com')).rejects.toBeInstanceOf(ProviderError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect downgrading to plain http', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: { get: () => 'http://registry2.example/domain/example.com' },
      body: redirectBody,
    });
    await expect(provider.confirm('example.com')).rejects.toBeInstanceOf(ProviderError);
  });

  it('refuses a redirect chain longer than two hops', async () => {
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: { get: () => 'https://hop.example/domain/example.com' },
        body: redirectBody,
      });
    }
    await expect(provider.confirm('example.com')).rejects.toBeInstanceOf(ProviderError);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('treats a 3xx without a Location header as Unknown', async () => {
    mockFetch.mockResolvedValue({
      status: 302,
      ok: false,
      headers: { get: () => null },
      body: redirectBody,
    });
    const result = await provider.confirm('example.com');
    expect(result.status).toBe(DomainStatus.Unknown);
  });

  it('aborts a body larger than the configured cap', async () => {
    const capped = new PublicRdapProvider(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1024,
      publicLookup,
    );
    const body = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2048)));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body,
    });
    await expect(capped.confirm('example.com')).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects a response whose content-length already exceeds the cap', async () => {
    const capped = new PublicRdapProvider(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1024,
      publicLookup,
    );
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: {
        get: (name: string): string | null => (name === 'content-length' ? '999999' : null),
      },
      body: { cancel: vi.fn() },
    });
    await expect(capped.confirm('example.com')).rejects.toBeInstanceOf(ProviderError);
  });
});
