/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { PortfolioRescoreHandler } from '../portfolio-rescore-handler.js';

describe('PortfolioRescoreHandler', () => {
  it('rescres all when no domain specified', async () => {
    const portfolioManager = {
      list: vi.fn().mockReturnValue([]),
      rescoreAll: vi.fn().mockResolvedValue({
        results: [{ domain: 'example.com' }],
        totalDurationMs: 500,
      }),
    };
    const rescoreService = { rescore: vi.fn() };
    const handler = new PortfolioRescoreHandler({ portfolioManager, rescoreService } as any);

    const result = await handler.handle({});

    expect(portfolioManager.rescoreAll).toHaveBeenCalled();
    expect(result.rescored).toBe(1);
  });

  it('rescres a specific domain found in portfolio', async () => {
    const portfolioManager = {
      list: vi.fn().mockReturnValue([{ entry: { domain: 'example.com', tld: '.com' } }]),
      rescoreAll: vi.fn(),
    };
    const rescoreService = {
      rescore: vi.fn().mockResolvedValue({
        results: [{ domain: 'example.com' }],
        totalDurationMs: 300,
      }),
    };
    const handler = new PortfolioRescoreHandler({ portfolioManager, rescoreService } as any);

    const result = await handler.handle({ domain: 'example.com' });

    expect(rescoreService.rescore).toHaveBeenCalled();
    expect(result.rescored).toBe(1);
  });

  it('returns error when domain not in portfolio', async () => {
    const portfolioManager = {
      list: vi.fn().mockReturnValue([{ entry: { domain: 'other.com', tld: '.com' } }]),
      rescoreAll: vi.fn(),
    };
    const rescoreService = { rescore: vi.fn() };
    const handler = new PortfolioRescoreHandler({ portfolioManager, rescoreService } as any);

    const result = await handler.handle({ domain: 'missing.com' });

    expect(rescoreService.rescore).not.toHaveBeenCalled();
    expect(result.rescored).toBe(0);
    expect(result.errors).toEqual([{ domain: 'missing.com', error: 'Not found in portfolio' }]);
  });

  it('reports rescore errors', async () => {
    const portfolioManager = {
      list: vi.fn().mockReturnValue([{ entry: { domain: 'bad.com', tld: '.com' } }]),
      rescoreAll: vi.fn(),
    };
    const rescoreService = {
      rescore: vi.fn().mockResolvedValue({
        results: [{ domain: 'bad.com', error: 'TM gate failed' }],
        totalDurationMs: 100,
      }),
    };
    const handler = new PortfolioRescoreHandler({ portfolioManager, rescoreService } as any);

    const result = await handler.handle({ domain: 'bad.com' });

    expect(result.errors).toEqual([{ domain: 'bad.com', error: 'TM gate failed' }]);
  });

  it('has the correct jobType', () => {
    const handler = new PortfolioRescoreHandler({
      portfolioManager: {},
      rescoreService: {},
    } as any);
    expect(handler.jobType).toBe('PORTFOLIO_RESCORE');
  });
});
