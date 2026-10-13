// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { IndexingService } from '../indexing-service.js';

const KEY = 'abc123def456abc123def456';

function fetchMock(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({ status }) as unknown as typeof fetch;
}

describe('IndexingService', () => {
  it('is not configured without a key', () => {
    expect(new IndexingService({}).isConfigured).toBe(false);
    expect(new IndexingService({ indexNextKeyPlaceholder: '' } as never).isConfigured).toBe(false);
  });

  it('rejects keys shorter than 8 characters', () => {
    expect(new IndexingService({ indexNowKey: 'short' }).isConfigured).toBe(false);
  });

  it('exposes the key file content only when configured', () => {
    expect(new IndexingService({}).keyFileContent()).toBeNull();
    expect(new IndexingService({ indexNowKey: KEY }).keyFileContent()).toBe(KEY);
  });

  it('matches only the configured key', () => {
    const service = new IndexingService({ indexNowKey: KEY });
    expect(service.matchesKey(KEY)).toBe(true);
    expect(service.matchesKey('other')).toBe(false);
  });

  it('submits urls to the IndexNow endpoint with key location', async () => {
    const fetchImpl = fetchMock(200);
    const service = new IndexingService({ indexNowKey: KEY, fetchImpl });

    const results = await service.submitUrls(
      ['https://dominus.app/public/for-sale/vintagecoffee.com'],
      'dominus.app',
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.indexnow.org/indexnow',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          host: 'dominus.app',
          key: KEY,
          keyLocation: `https://dominus.app/${KEY}.txt`,
          urlList: ['https://dominus.app/public/for-sale/vintagecoffee.com'],
        }),
      }),
    );
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.status).toBe(200);
  });

  it('treats 202 as accepted', async () => {
    const service = new IndexingService({ indexNowKey: KEY, fetchImpl: fetchMock(202) });
    const [result] = await service.submitUrls(['https://dominus.app/x'], 'dominus.app');
    expect(result?.ok).toBe(true);
  });

  it('marks a 403 refusal as failed', async () => {
    const service = new IndexingService({ indexNowKey: KEY, fetchImpl: fetchMock(403) });
    const [result] = await service.submitUrls(['https://dominus.app/x'], 'dominus.app');
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('indexnow_http_403');
  });

  it('marks a network failure as failed without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('dns down')) as unknown as typeof fetch;
    const service = new IndexingService({ indexNowKey: KEY, fetchImpl });
    const [result] = await service.submitUrls(['https://dominus.app/x'], 'dominus.app');
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('dns down');
  });

  it('refuses every url when unconfigured', async () => {
    const service = new IndexingService({});
    const results = await service.submitUrls(['https://dominus.app/x'], 'dominus.app');
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toBe('indexnow_not_configured');
  });
});
