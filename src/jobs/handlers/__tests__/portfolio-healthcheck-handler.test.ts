/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { PortfolioHealthcheckHandler } from '../portfolio-healthcheck-handler.js';

describe('PortfolioHealthcheckHandler', () => {
  it('calls healthcheckService.checkExpiring with payload defaults and formats the result', async () => {
    const healthcheckService = {
      checkExpiring: vi.fn().mockResolvedValue({ checked: 5, updated: 2, errors: 0, details: [] }),
    };
    const handler = new PortfolioHealthcheckHandler({ healthcheckService } as any);

    const result = await handler.handle({});

    expect(healthcheckService.checkExpiring).toHaveBeenCalledWith(90, 100, undefined);
    expect(result).toEqual({ checked: 5, updated: 2, errors: 0 });
  });

  it('forwards custom horizonDays, batchSize, and abort signal', async () => {
    const healthcheckService = {
      checkExpiring: vi.fn().mockResolvedValue({ checked: 1, updated: 0, errors: 0, details: [] }),
    };
    const handler = new PortfolioHealthcheckHandler({ healthcheckService } as any);
    const signal = new AbortController().signal;

    await handler.handle({ horizonDays: 30, batchSize: 10 }, signal);

    expect(healthcheckService.checkExpiring).toHaveBeenCalledWith(30, 10, signal);
  });

  it('has the correct jobType', () => {
    const handler = new PortfolioHealthcheckHandler({ healthcheckService: {} } as any);
    expect(handler.jobType).toBe('PORTFOLIO_HEALTHCHECK');
  });
});
