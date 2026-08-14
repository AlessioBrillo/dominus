// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FailoverRdapProvider } from '../failover-rdap-provider.js';
import {
  IanaRdapBootstrap,
  IANA_RDAP_BOOTSTRAP_URL,
  RDAP_ORG_UNIVERSAL,
} from '../rdap-bootstrap.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { RdapBootstrapServer, BootstrapStatus } from '../rdap-bootstrap.js';
import type { Dispatcher } from 'undici';

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

  it('warm() starts the bootstrap fetch without blocking the caller', async () => {
    mockFetchResponse(IANA_SAMPLE);
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    bootstrap.warm();

    // The fetch starts immediately, even though warm() returns synchronously.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // Once the warm fetch lands, the authoritative servers are served.
    await vi.waitFor(async () => {
      const servers = await bootstrap.getServers('com');
      expect(servers.some((s) => s.name === 'rdap.verisign.com')).toBe(true);
    });
  });

  it('warm() never throws when the bootstrap fetch fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    expect(() => bootstrap.warm()).not.toThrow();
    // The failure degrades to rdap.org routing, exactly like a cold fetch.
    await vi.waitFor(async () => {
      expect(await bootstrap.getServers('com')).toEqual([RDAP_ORG_UNIVERSAL]);
    });
  });

  it('does not stall the first query on an in-flight warm-up fetch', async () => {
    // The bootstrap fetch takes 3s; a query arriving during warm-up must
    // not wait for it — rdap.org routing covers the gap.
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: async () => IANA_SAMPLE,
            } as Response);
          }, 3000);
        }),
    ) as unknown as typeof fetch;
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');

    bootstrap.warm();
    const start = Date.now();
    const servers = await bootstrap.getServers('com');
    const elapsed = Date.now() - start;

    expect(servers).toEqual([RDAP_ORG_UNIVERSAL]);
    expect(elapsed).toBeLessThan(2500);
    // The warm fetch completes in the background and fills the cache.
    await vi.waitFor(
      async () => {
        const after = await bootstrap.getServers('com');
        expect(after.some((s) => s.name === 'rdap.verisign.com')).toBe(true);
      },
      { timeout: 5000 },
    );
  });
});

describe('IanaRdapBootstrap backoff and status (ADR-0058)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off exponentially and refetches only when the window elapses', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json', 60_000, {
      retryBaseMs: 10,
      retryMaxMs: 100,
    });

    await bootstrap.getServers('com');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(bootstrap.getStatus()).toMatchObject({ ok: false, consecutiveFailures: 1 });

    // Still inside the backoff window: no refetch is attempted.
    await bootstrap.getServers('com');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Once the window elapses the next attempt fires.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await bootstrap.getServers('com');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(bootstrap.getStatus().consecutiveFailures).toBe(2);
  });

  it('caps the exponential backoff at retryMaxMs', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json', 60_000, {
      retryBaseMs: 10,
      retryMaxMs: 15,
    });

    await bootstrap.getServers('com');
    expect(bootstrap.getStatus().nextRetryAt).toBe(Date.now() + 10);

    await vi.advanceTimersByTimeAsync(11);
    await bootstrap.getServers('com');
    expect(bootstrap.getStatus().nextRetryAt).toBe(Date.now() + 15);

    await vi.advanceTimersByTimeAsync(16);
    await bootstrap.getServers('com');
    // 2^2 * 10 = 40 would be the uncapped delay; the cap holds at 15.
    expect(bootstrap.getStatus().nextRetryAt).toBe(Date.now() + 15);
    expect(bootstrap.getStatus().consecutiveFailures).toBe(3);
  });

  it('keeps serving cached servers during a backoff window after a failed refresh', async () => {
    mockFetchResponse(IANA_SAMPLE);
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json', 1, {
      retryBaseMs: 10_000,
      retryMaxMs: 10_000,
    });
    await bootstrap.refresh();

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await bootstrap.refresh();

    const servers = await bootstrap.getServers('com');
    expect(servers.some((s) => s.name === 'rdap.verisign.com')).toBe(true);
    // Only the failed refresh hit the network; the backoff window held.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(bootstrap.getStatus().consecutiveFailures).toBe(1);
  });

  it('notifies status listeners on success and failure', async () => {
    const events: BootstrapStatus[] = [];
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');
    bootstrap.subscribeStatus((status) => events.push(status));

    mockFetchResponse(IANA_SAMPLE);
    await bootstrap.refresh();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ok: true, consecutiveFailures: 0 });
    expect(events[0]?.lastSuccessAt).not.toBeNull();

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await bootstrap.refresh();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ ok: false, consecutiveFailures: 1 });
    expect(events[1]?.nextRetryAt).not.toBeNull();
    expect(events[1]?.lastError).toBe('network down');
  });

  it('routes the bootstrap fetch through the shared agent pool dispatcher', async () => {
    const dispatcher = { fake: true } as unknown as Dispatcher;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => IANA_SAMPLE,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json', 60_000, {
      getDispatcher: async (): Promise<Dispatcher> => dispatcher,
    });
    await bootstrap.refresh();

    const init = fetchMock.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBe(dispatcher);
  });

  it('unsubscribes a status listener', async () => {
    const events: BootstrapStatus[] = [];
    const bootstrap = new IanaRdapBootstrap('https://example.invalid/dns.json');
    const unsubscribe = bootstrap.subscribeStatus((status) => events.push(status));

    mockFetchResponse(IANA_SAMPLE);
    await bootstrap.refresh();
    expect(events).toHaveLength(1);

    unsubscribe();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await bootstrap.refresh();
    expect(events).toHaveLength(1);
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
