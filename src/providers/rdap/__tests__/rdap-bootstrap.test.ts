// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FailoverRdapProvider } from '../failover-rdap-provider.js';
import {
  IanaRdapBootstrap,
  IANA_RDAP_BOOTSTRAP_URL,
  RDAP_ORG_UNIVERSAL,
} from '../rdap-bootstrap.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { RdapBootstrapServer } from '../rdap-bootstrap.js';

const IANA_SAMPLE = {
  services: [
    {
      ldhName: ['COM', 'NET'],
      urls: ['https://rdap.verisign.com/com/v1/'],
    },
    {
      ldhName: ['IO'],
      urls: ['https://rdap.identitydigital.services/rdap/'],
    },
  ],
};

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function mockFetchResponse(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('IanaRdapBootstrap', () => {
  it('uses the IANA registry URL by default', () => {
    expect(IANA_RDAP_BOOTSTRAP_URL).toBe('https://data.iana.org/rdap/dns.json');
  });

  it('resolves the authoritative server per TLD from the bootstrap', async () => {
    mockFetchResponse(IANA_SAMPLE);
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    const servers = await bootstrap.getServers('com');
    expect(servers).toHaveLength(2); // verisign + rdap.org fallback
    const verisign = servers.find((s) => s.name === 'rdap.verisign.com');
    expect(verisign?.baseUrl).toBe('https://rdap.verisign.com/com/v1/');
    expect(verisign?.tlds).toEqual(['com']);
    expect(servers.some((s) => s.name === 'rdap.org')).toBe(true);
  });

  it('treats the TLD case-insensitively and with or without the leading dot', async () => {
    mockFetchResponse(IANA_SAMPLE);
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    const upper = await bootstrap.getServers('IO');
    const dotted = await bootstrap.getServers('.io');
    expect(upper[0]?.baseUrl).toBe('https://rdap.identitydigital.services/rdap/');
    expect(dotted[0]?.baseUrl).toBe('https://rdap.identitydigital.services/rdap/');
  });

  it('fetches the bootstrap only once within the TTL', async () => {
    mockFetchResponse(IANA_SAMPLE);
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json', 60_000);

    await bootstrap.getServers('com');
    await bootstrap.getServers('net');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to rdap.org for unknown TLDs', async () => {
    mockFetchResponse(IANA_SAMPLE);
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    const servers = await bootstrap.getServers('nonexistent');
    expect(servers).toEqual([RDAP_ORG_UNIVERSAL]);
  });

  it('falls back to rdap.org when the bootstrap fetch fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    const servers = await bootstrap.getServers('com');
    expect(servers).toEqual([RDAP_ORG_UNIVERSAL]);
  });

  it('falls back to rdap.org when the bootstrap returns a non-200 status', async () => {
    mockFetchResponse({}, 500);
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    const servers = await bootstrap.getServers('com');
    expect(servers).toEqual([RDAP_ORG_UNIVERSAL]);
  });
});

function makeBootstrap(serversByTld: Record<string, RdapBootstrapServer[]>): IanaRdapBootstrap {
  const bootstrap = {} as IanaRdapBootstrap;
  (bootstrap as { getServers: unknown }).getServers = vi.fn(
    async (tld: string) => serversByTld[tld.toLowerCase()] ?? [RDAP_ORG_UNIVERSAL],
  );
  return bootstrap;
}

describe('FailoverRdapProvider per-TLD selection', () => {
  it('queries only the servers authoritative for the domain TLD', async () => {
    // com.example → registered (200); io.example → never queried for .com.
    globalThis.fetch = vi.fn(async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes('com.example')) {
        return { ok: true, status: 200, json: async () => ({ handle: 'COM-1' }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const bootstrap = makeBootstrap({
      com: [{ name: 'com-authority', baseUrl: 'https://com.example/', tlds: ['com'] }],
      io: [{ name: 'io-authority', baseUrl: 'https://io.example/', tlds: ['io'] }],
    });

    const provider = new FailoverRdapProvider([], undefined, undefined, bootstrap);
    const result = await provider.confirm('example.com');

    expect(result.status).toBe(DomainStatus.Registered);
    expect(bootstrap.getServers).toHaveBeenCalledWith('com');
    const queriedUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(queriedUrls.some((u) => u.includes('com.example'))).toBe(true);
    expect(queriedUrls.some((u) => u.includes('io.example'))).toBe(false);
  });

  it('uses the rdap.org universal fallback for unknown TLDs', async () => {
    // Unknown TLD: rdap.org is queried (it is not a 404-from-wrong-server
    // case — it serves all TLDs), and a 404 there means Available.
    globalThis.fetch = vi.fn(
      async (): Promise<Response> =>
        ({
          ok: false,
          status: 404,
          json: async () => ({}),
        }) as Response,
    ) as unknown as typeof fetch;

    const bootstrap = makeBootstrap({});
    const provider = new FailoverRdapProvider([], undefined, undefined, bootstrap);
    const result = await provider.confirm('example.unknown');

    expect(result.status).toBe(DomainStatus.Available);
    const queriedUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(queriedUrls.some((u) => u.includes('rdap.org'))).toBe(true);
  });

  it('resolves the per-TLD provider list once and reuses it', async () => {
    globalThis.fetch = vi.fn(
      async (): Promise<Response> =>
        ({
          ok: false,
          status: 404,
          json: async () => ({}),
        }) as Response,
    ) as unknown as typeof fetch;

    const bootstrap = makeBootstrap({
      com: [{ name: 'com-authority', baseUrl: 'https://com.example/', tlds: ['com'] }],
    });

    const provider = new FailoverRdapProvider([], undefined, undefined, bootstrap);
    await provider.confirm('example.com');
    await provider.confirm('other.com');

    expect(bootstrap.getServers).toHaveBeenCalledTimes(1);
  });
});
