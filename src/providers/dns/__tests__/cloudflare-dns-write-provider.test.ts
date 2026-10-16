// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { CloudflareDnsWriteProvider } from '../cloudflare-dns-write-provider.js';
import { ProviderError } from '../../../types/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function zoneResponse(name = 'example.com'): unknown {
  return {
    success: true,
    errors: [],
    messages: [],
    result: [
      {
        id: 'zone-1',
        name,
        name_servers: ['ns1.cloudflare.com.', 'ns2.cloudflare.com'],
        status: 'active',
      },
    ],
  };
}

function recordsResponse(records: unknown[] = []): unknown {
  return { success: true, errors: [], messages: [], result: records };
}

/** Route mock fetches by method + path pattern. */
function mockFetch(routes: Array<{ match: RegExp; method: string; body: unknown }>): typeof fetch {
  return vi.fn(async (input, init?: { method?: string }) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.method === method && r.match.test(url));
    if (!route) {
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }
    return jsonResponse(route.body);
  }) as unknown as typeof fetch;
}

describe('CloudflareDnsWriteProvider', () => {
  it('is unavailable without a token', () => {
    const provider = new CloudflareDnsWriteProvider('');
    expect(provider.isAvailable).toBe(false);
  });

  it('is available with a token', () => {
    const provider = new CloudflareDnsWriteProvider('token');
    expect(provider.isAvailable).toBe(true);
  });

  it('reads the zone state with normalised nameservers', async () => {
    const fetchImpl = mockFetch([
      { match: /\/zones\?name=/, method: 'GET', body: zoneResponse() },
      {
        match: /dns_records/,
        method: 'GET',
        body: recordsResponse([
          { id: 'r1', type: 'A', name: 'example.com', content: '1.2.3.4', ttl: 1 },
        ]),
      },
    ]);
    const provider = new CloudflareDnsWriteProvider('token', fetchImpl);

    const state = await provider.readZoneState('example.com');

    expect(state).not.toBeNull();
    expect(state?.managed).toBe(true);
    expect(state?.expectedNameServers).toEqual(['ns1.cloudflare.com', 'ns2.cloudflare.com']);
    expect(state?.records).toEqual([
      { type: 'A', name: 'example.com', content: '1.2.3.4', ttl: 1 },
    ]);
  });

  it('returns null when the zone is not managed', async () => {
    const fetchImpl = mockFetch([
      {
        match: /\/zones\?name=/,
        method: 'GET',
        body: { success: true, errors: [], messages: [], result: [] },
      },
    ]);
    const provider = new CloudflareDnsWriteProvider('token', fetchImpl);

    expect(await provider.readZoneState('other.com')).toBeNull();
  });

  it('creates records that do not exist', async () => {
    const fetchImpl = mockFetch([
      { match: /\/zones\?name=/, method: 'GET', body: zoneResponse() },
      { match: /dns_records/, method: 'GET', body: recordsResponse() },
      {
        match: /dns_records/,
        method: 'POST',
        body: { success: true, errors: [], messages: [], result: { id: 'r2' } },
      },
    ]);
    const provider = new CloudflareDnsWriteProvider('token', fetchImpl);

    const outcome = await provider.ensureRecords('example.com', [
      { type: 'A', name: '@', content: '5.6.7.8' },
    ]);

    expect(outcome.applied).toBe(true);
    expect(outcome.changed).toEqual([{ type: 'A', name: '@', content: '5.6.7.8' }]);
    const postCall = vi.mocked(fetchImpl).mock.calls.find((c) => c[1]?.method === 'POST');
    expect(postCall).toBeDefined();
    expect(String(postCall?.[1]?.body)).toContain('5.6.7.8');
  });

  it('is idempotent when the records already match', async () => {
    const fetchImpl = mockFetch([
      { match: /\/zones\?name=/, method: 'GET', body: zoneResponse() },
      {
        match: /dns_records/,
        method: 'GET',
        body: recordsResponse([
          { id: 'r1', type: 'A', name: 'example.com', content: '5.6.7.8', ttl: 1 },
        ]),
      },
    ]);
    const provider = new CloudflareDnsWriteProvider('token', fetchImpl);

    const outcome = await provider.ensureRecords('example.com', [
      { type: 'A', name: '@', content: '5.6.7.8' },
    ]);

    expect(outcome.changed).toEqual([]);
    expect(outcome.message).toBe('records already in the desired state');
    expect(vi.mocked(fetchImpl).mock.calls.every((c) => (c[1]?.method ?? 'GET') === 'GET')).toBe(
      true,
    );
  });

  it('patches the record when the content differs', async () => {
    const fetchImpl = mockFetch([
      { match: /\/zones\?name=/, method: 'GET', body: zoneResponse() },
      {
        match: /dns_records/,
        method: 'GET',
        body: recordsResponse([
          { id: 'r1', type: 'A', name: 'example.com', content: '1.1.1.1', ttl: 1 },
        ]),
      },
      {
        match: /dns_records\/r1/,
        method: 'PATCH',
        body: { success: true, errors: [], messages: [], result: { id: 'r1' } },
      },
    ]);
    const provider = new CloudflareDnsWriteProvider('token', fetchImpl);

    const outcome = await provider.ensureRecords('example.com', [
      { type: 'A', name: '@', content: '5.6.7.8' },
    ]);

    expect(outcome.changed).toHaveLength(1);
    const patchCall = vi.mocked(fetchImpl).mock.calls.find((c) => c[1]?.method === 'PATCH');
    expect(patchCall?.[0]).toContain('dns_records/r1');
  });

  it('throws ProviderError on an API failure', async () => {
    const fetchImpl = mockFetch([
      {
        match: /\/zones\?name=/,
        method: 'GET',
        body: {
          success: false,
          errors: [{ code: 10000, message: 'auth failed' }],
          messages: [],
          result: null,
        },
      },
    ]);
    const provider = new CloudflareDnsWriteProvider('token', fetchImpl);

    await expect(provider.readZoneState('example.com')).rejects.toThrow(ProviderError);
    await expect(provider.readZoneState('example.com')).rejects.toThrow(/auth failed/);
  });
});
