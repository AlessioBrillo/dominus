/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { WatchlistPollHandler } from '../watchlist-handler.js';

describe('WatchlistPollHandler', () => {
  it('calls watchlistService.poll and returns its result', async () => {
    const watchlistService = {
      poll: vi.fn().mockResolvedValue({ checked: 10, available: 2, notified: 1, errors: 0 }),
    };
    const handler = new WatchlistPollHandler({ watchlistService } as any);

    const result = await handler.handle({});

    expect(watchlistService.poll).toHaveBeenCalled();
    expect(result.checked).toBe(10);
    expect(result.available).toBe(2);
    expect(result.notified).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('has the correct jobType', () => {
    const handler = new WatchlistPollHandler({ watchlistService: {} } as any);
    expect(handler.jobType).toBe('WATCHLIST_POLL');
  });
});
