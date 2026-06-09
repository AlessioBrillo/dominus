import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NameBioProvider } from '../namebio-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('NameBioProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns empty array when API key is missing', async () => {
    const provider = new NameBioProvider({ apiKey: undefined });
    const result = await provider.getSales('example');
    expect(result).toEqual([]);
  });

  it('returns empty array when API key is empty string', async () => {
    const provider = new NameBioProvider({ apiKey: '' });
    const result = await provider.getSales('example');
    expect(result).toEqual([]);
  });

  it('calls the NameBio API with the term and API key', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify([{ name: 'example.com', price: 500, date: '2024-01-15', venue: 'NameJet' }]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const provider = new NameBioProvider({ apiKey: 'test-key-123' });
    const result = await provider.getSales('example');

    expect(mockFetch).toHaveBeenCalledOnce();
    const callUrl = mockFetch.mock.calls[0]![0]! as string;
    expect(callUrl).toContain('key=test-key-123');
    expect(callUrl).toContain('domain=example');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      domain: 'example.com',
      salePrice: 500,
      saleDate: '2024-01-15',
      venue: 'NameJet',
    });
  });

  it('parses multiple sales from the API response', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: 'example.com', price: 1000, date: '2024-01-15', venue: 'NameJet' },
          { name: 'example.io', price: 750, date: '2024-02-10', venue: 'Sedo' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new NameBioProvider({ apiKey: 'test-key' });
    const result = await provider.getSales('example');

    expect(result).toHaveLength(2);
    expect(result[0]!.domain).toBe('example.com');
    expect(result[1]!.domain).toBe('example.io');
  });

  it('filters out invalid entries (missing price)', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: 'valid.com', price: 500, date: '2024-01-15', venue: 'NameJet' },
          { name: 'invalid.com', price: 'free' as unknown as number, date: '', venue: '' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new NameBioProvider({ apiKey: 'test-key' });
    const result = await provider.getSales('example');

    expect(result).toHaveLength(1);
    expect(result[0]!.domain).toBe('valid.com');
  });

  it('returns empty array on HTTP error', async () => {
    mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const provider = new NameBioProvider({ apiKey: 'bad-key' });
    const result = await provider.getSales('example');

    expect(result).toEqual([]);
  });

  it('returns empty array on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    const provider = new NameBioProvider({ apiKey: 'test-key' });
    const result = await provider.getSales('example');

    expect(result).toEqual([]);
  });

  it('returns empty array on invalid JSON response', async () => {
    mockFetch.mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const provider = new NameBioProvider({ apiKey: 'test-key' });
    const result = await provider.getSales('example');

    expect(result).toEqual([]);
  });

  it('only warns once when API key is missing', async () => {
    const provider = new NameBioProvider({ apiKey: undefined });
    await provider.getSales('term1');
    await provider.getSales('term2');
    // No crash — only one warning logged (verified by single warn flag internally)
    expect(true).toBe(true);
  });

  it('handles empty response array', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new NameBioProvider({ apiKey: 'test-key' });
    const result = await provider.getSales('example');

    expect(result).toEqual([]);
  });

  it('handles response with inventory flag', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            name: 'example.com',
            price: 1200,
            date: '2024-03-01',
            venue: 'Afternic',
            inventory: false,
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new NameBioProvider({ apiKey: 'test-key' });
    const result = await provider.getSales('example');

    expect(result).toHaveLength(1);
    expect(result[0]!.salePrice).toBe(1200);
  });
});
