/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { BacktestBuildHandler } from '../backtest-handler.js';

describe('BacktestBuildHandler', () => {
  it('builds signals and suggests weights when minSampleSize met', async () => {
    const deps = {
      backtestEngine: { snapshot: vi.fn().mockReturnValue({ inserted: 10 }) },
      weightSuggester: {
        suggest: vi.fn().mockReturnValue({
          suggestions: [
            { signal: 'lengthWeight', suggestedWeight: 0.2, currentWeight: 0.15 },
            { signal: 'keywordVolumeWeight', suggestedWeight: 0.25, currentWeight: 0.3 },
          ],
          sampleSize: 10,
        }),
      },
      currentWeights: {},
    };
    const handler = new BacktestBuildHandler(deps as any);

    const result = await handler.handle({ minSampleSize: 5 });

    expect(deps.backtestEngine.snapshot).toHaveBeenCalled();
    expect(deps.weightSuggester.suggest).toHaveBeenCalled();
    expect(result.signalsBuilt).toBe(10);
    expect(result.weightSuggestion).toBeDefined();
    expect(result.weightSuggestion!.suggestedWeights.lengthWeight).toBe(0.2);
    expect(result.weightSuggestion!.deltas.lengthWeight).toBeCloseTo(0.05, 4);
    expect(result.weightSuggestion!.sampleSize).toBe(10);
  });

  it('returns only signalsBuilt when insufficient samples', async () => {
    const deps = {
      backtestEngine: { snapshot: vi.fn().mockReturnValue({ inserted: 3 }) },
      weightSuggester: { suggest: vi.fn() },
      currentWeights: {},
    };
    const handler = new BacktestBuildHandler(deps as any);

    const result = await handler.handle({ minSampleSize: 5 });

    expect(result.signalsBuilt).toBe(3);
    expect(result.weightSuggestion).toBeUndefined();
    expect(deps.weightSuggester.suggest).not.toHaveBeenCalled();
  });

  it('uses default minSampleSize of 5', async () => {
    const deps = {
      backtestEngine: { snapshot: vi.fn().mockReturnValue({ inserted: 3 }) },
      weightSuggester: { suggest: vi.fn() },
      currentWeights: {},
    };
    const handler = new BacktestBuildHandler(deps as any);

    const result = await handler.handle({});

    expect(result.signalsBuilt).toBe(3);
    expect(result.weightSuggestion).toBeUndefined();
  });

  it('has the correct jobType', () => {
    const handler = new BacktestBuildHandler({} as any);
    expect(handler.jobType).toBe('BACKTEST_BUILD');
  });
});
