import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NodeWhoisProvider,
  NodeWhoisProviderWithIanaFallback,
  parseWhoisResponse,
} from '../node-whois-provider.js';
import type { Socket } from 'node:net';
import { ProviderError } from '../../../types/errors.js';
import { clearIanaCache } from '../iana-server-lookup.js';

type ConnectFn = (port: number, host: string, callback?: () => void) => Socket;

function makeMockConnect(): {
  connect: ConnectFn;
  emittedEvents: Array<{ emit: (event: string, ...args: unknown[]) => void }>;
} {
  const emittedEvents: Array<{ emit: (event: string, ...args: unknown[]) => void }> = [];
  const connect = vi.fn((_port: number, _host: string, callback?: () => void) => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    const emit = (event: string, ...args: unknown[]): void => {
      const h = handlers.get(event);
      if (h !== undefined) {
        for (const handler of h) handler(...args);
      }
    };

    const socket = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const existing = handlers.get(event) ?? [];
        existing.push(handler);
        handlers.set(event, existing);
        return socket;
      }),
      setTimeout: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    } as unknown as Socket;

    emittedEvents.push({ emit });

    if (callback !== undefined) {
      process.nextTick(callback);
    }
    return socket;
  });

  return { connect: connect as unknown as ConnectFn, emittedEvents };
}

/** Complete a mock WHOIS connection by emitting a "not found" response + end. */
function completeSocket(events: { emit: (event: string, ...args: unknown[]) => void }): void {
  events.emit('data', Buffer.from('No match for.'));
  events.emit('end');
}

describe('parseWhoisResponse', () => {
  it('returns available=true for "No match for" response', () => {
    const r = parseWhoisResponse('example.com', 'No match for "EXAMPLE.COM".');
    expect(r.available).toBe(true);
    expect(r.domain).toBe('example.com');
  });

  it('returns available=true for "Domain not found"', () => {
    const r = parseWhoisResponse('missing.org', 'Domain not found.');
    expect(r.available).toBe(true);
  });

  it('returns available=true for "No Data Found"', () => {
    const r = parseWhoisResponse('none.io', 'No Data Found');
    expect(r.available).toBe(true);
  });

  it('returns available=true for "No entries found"', () => {
    const r = parseWhoisResponse('x.co', 'No entries found');
    expect(r.available).toBe(true);
  });

  it('returns available=true for "Status: free"', () => {
    const r = parseWhoisResponse('free.de', 'Status: free');
    expect(r.available).toBe(true);
  });

  it('returns available=false for registered domain without not-found patterns', () => {
    const r = parseWhoisResponse('taken.com', 'Domain Name: TAKEN.COM\nRegistry Domain ID: 123');
    expect(r.available).toBe(false);
  });

  it('parses registrar line', () => {
    const r = parseWhoisResponse(
      'example.com',
      'Registrar: GoDaddy, LLC\nDomain Name: EXAMPLE.COM',
    );
    expect(r.registrar).toBe('GoDaddy, LLC');
  });

  it('parses expiry date from common fields', () => {
    const r = parseWhoisResponse('example.com', 'Registry Expiry Date: 2028-06-07T23:59:59Z');
    expect(r.expiryDate).toBe('2028-06-07T23:59:59.000Z');
  });

  it('parses paid-till field (.de style)', () => {
    const r = parseWhoisResponse('example.de', 'paid-till: 2027-12-31T00:00:00Z');
    expect(r.expiryDate).toBe('2027-12-31T00:00:00.000Z');
  });

  it('ignores comment lines in registrar field', () => {
    const r = parseWhoisResponse(
      'example.com',
      '% Registrar: hidden\nRegistrar: The Real Registrar',
    );
    expect(r.registrar).toBe('The Real Registrar');
  });

  it('handles empty response', () => {
    const r = parseWhoisResponse('empty.com', '');
    expect(r.available).toBe(false);
    expect(r.registrar).toBeUndefined();
  });
});

describe('NodeWhoisProvider', () => {
  let mockConnect: ConnectFn;
  let emittedEvents: Array<{ emit: (event: string, ...args: unknown[]) => void }>;

  beforeEach(() => {
    vi.clearAllMocks();
    const m = makeMockConnect();
    mockConnect = m.connect;
    emittedEvents = m.emittedEvents;
  });

  function lastEvents(): { emit: (event: string, ...args: unknown[]) => void } {
    const e = emittedEvents[emittedEvents.length - 1];
    if (e === undefined) throw new Error('No socket created');
    return e;
  }

  it('resolves as available when WHOIS returns "No match for"', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    const promise = provider.checkAvailability('free-domain.com');
    process.nextTick(() => {
      lastEvents().emit('data', Buffer.from('No match for "FREE-DOMAIN.COM".'));
      lastEvents().emit('end');
    });
    const result = await promise;
    expect(result.available).toBe(true);
    expect(result.domain).toBe('free-domain.com');
  });

  it('resolves as not available for registered domain', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    const promise = provider.checkAvailability('taken.com');
    process.nextTick(() => {
      lastEvents().emit('data', Buffer.from('Domain Name: TAKEN.COM\nRegistrar: NameCheap'));
      lastEvents().emit('end');
    });
    const result = await promise;
    expect(result.available).toBe(false);
  });

  it('parses registrar from WHOIS response', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    const promise = provider.checkAvailability('example.io');
    process.nextTick(() => {
      lastEvents().emit('data', Buffer.from('Domain Name: EXAMPLE.IO\nRegistrar: NameCheap, Inc.'));
      lastEvents().emit('end');
    });
    const result = await promise;
    expect(result.registrar).toBe('NameCheap, Inc.');
  });

  it('parses expiry date', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    const promise = provider.checkAvailability('example.de');
    process.nextTick(() => {
      lastEvents().emit(
        'data',
        Buffer.from('Domain: example.de\nExpiry Date: 2027-12-31T23:59:59Z'),
      );
      lastEvents().emit('end');
    });
    const result = await promise;
    expect(result.expiryDate).toBe('2027-12-31T23:59:59.000Z');
  });

  it('rejects with ProviderError on timeout', async () => {
    const provider = new NodeWhoisProvider({
      timeoutMs: 5000,
      connect: mockConnect,
      tlsEnabled: false,
    });
    const promise = provider.checkAvailability('timeout-test.com');
    process.nextTick(() => {
      lastEvents().emit('timeout');
    });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toMatchObject({ code: 'WHOIS_LOOKUP_FAILED' });
  });

  it('rejects with ProviderError on socket error', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    const promise = provider.checkAvailability('error-test.com');
    process.nextTick(() => {
      lastEvents().emit('error', new Error('ECONNREFUSED'));
    });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
  });

  it('connects to verisign-grs for .com', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    const promise = provider.checkAvailability('test.com');
    process.nextTick(() => {
      lastEvents().emit('data', Buffer.from('No match for'));
      lastEvents().emit('end');
    });
    await promise;
    expect(mockConnect).toHaveBeenCalledWith(43, 'whois.verisign-grs.com', expect.any(Function));
  });

  it('connects to nic.io for .io', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    const promise = provider.checkAvailability('test.io');
    process.nextTick(() => {
      lastEvents().emit('data', Buffer.from('No match for'));
      lastEvents().emit('end');
    });
    await promise;
    expect(mockConnect).toHaveBeenCalledWith(43, 'whois.nic.io', expect.any(Function));
  });

  it('throws WHOIS_NO_SERVER for unknown TLDs', async () => {
    const provider = new NodeWhoisProvider({ timeoutMs: 5000, connect: mockConnect });
    await expect(provider.checkAvailability('test.unknown-tld-xyz')).rejects.toMatchObject({
      code: 'WHOIS_NO_SERVER',
    });
  });

  it('uses server overrides when provided', async () => {
    const provider = new NodeWhoisProvider({
      connect: mockConnect,
      serverOverrides: { '.com': 'custom.whois.test' },
    });
    const promise = provider.checkAvailability('test.com');
    process.nextTick(() => {
      lastEvents().emit('data', Buffer.from('No match for'));
      lastEvents().emit('end');
    });
    await promise;
    expect(mockConnect).toHaveBeenCalledWith(43, 'custom.whois.test', expect.any(Function));
  });
});

describe('NodeWhoisProviderWithIanaFallback', () => {
  let mockConnect: ConnectFn;
  let emittedEvents: Array<{ emit: (event: string, ...args: unknown[]) => void }>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearIanaCache();
    const m = makeMockConnect();
    mockConnect = m.connect;
    emittedEvents = m.emittedEvents;
  });

  function lastEmitted(): { emit: (event: string, ...args: unknown[]) => void } {
    const e = emittedEvents[emittedEvents.length - 1];
    if (e === undefined) throw new Error('No socket created');
    return e;
  }

  it('falls back to IANA when WHOIS_NO_SERVER for unknown TLD', async () => {
    const provider = new NodeWhoisProviderWithIanaFallback({
      timeoutMs: 5000,
      connect: mockConnect,
    });

    const p = provider.checkAvailability('test.unknown');

    // Wait for the async catch handler to call resolveWhoisServer
    await vi.waitFor(
      () => {
        expect(emittedEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000, interval: 10 },
    );

    // IANA responds with a WHOIS server
    lastEmitted().emit(
      'data',
      Buffer.from('domain: UNKNOWN\nwhois: whois.nic.unknown\nstatus: active\n'),
    );
    lastEmitted().emit('end');

    // Wait for second connection (to discovered server) + complete it
    await vi.waitFor(
      () => {
        expect(emittedEvents.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 1000, interval: 10 },
    );

    completeSocket(lastEmitted());
    await expect(p).resolves.toBeDefined();

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockConnect).toHaveBeenNthCalledWith(1, 43, 'whois.iana.org', expect.any(Function));
    expect(mockConnect).toHaveBeenNthCalledWith(2, 43, 'whois.nic.unknown', expect.any(Function));
  });

  it('re-throws non-WHOIS_NO_SERVER errors', async () => {
    const provider = new NodeWhoisProviderWithIanaFallback({
      timeoutMs: 100,
      connect: mockConnect,
    });
    const promise = provider.checkAvailability('test.com');
    process.nextTick(() => {
      lastEmitted().emit('error', new Error('ECONNREFUSED'));
    });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
  });

  it('re-throws WHOIS_NO_SERVER when IANA also returns no server', async () => {
    const provider = new NodeWhoisProviderWithIanaFallback({
      timeoutMs: 5000,
      connect: mockConnect,
    });

    const p = provider.checkAvailability('test.void');

    // Wait for IANA connection
    await vi.waitFor(
      () => {
        expect(emittedEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000, interval: 10 },
    );

    // IANA responds with no whois server line
    lastEmitted().emit('data', Buffer.from('domain: VOID\nstatus: not assigned\n'));
    lastEmitted().emit('end');

    await expect(p).rejects.toMatchObject({ code: 'WHOIS_NO_SERVER' });
  });
});
