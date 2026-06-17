import { describe, it, expect, vi } from 'vitest';
import { WeightTuneHandler } from '../weight-tune-handler.js';

const mockTune = vi.fn();

const mockAutoTuner = {
  tune: mockTune,
};

function createHandler(): WeightTuneHandler {
  return new WeightTuneHandler({ autoTuner: mockAutoTuner });
}

describe('WeightTuneHandler', () => {
  it('has jobType WEIGHT_TUNE', () => {
    const handler = createHandler();
    expect(handler.jobType).toBe('WEIGHT_TUNE');
  });

  it('calls autoTuner.tune() and returns its outcome', async () => {
    mockTune.mockResolvedValueOnce({
      sampleSize: 42,
      applied: true,
      safety: { passed: true },
      dryRun: false,
    });

    const handler = createHandler();
    const result = await handler.handle({});

    expect(mockTune).toHaveBeenCalledOnce();
    expect(result).toEqual({
      sampleSize: 42,
      applied: true,
      safetyPassed: true,
      dryRun: false,
    });
  });

  it('reports safety failure', async () => {
    mockTune.mockResolvedValueOnce({
      sampleSize: 10,
      applied: false,
      safety: { passed: false },
      dryRun: true,
    });

    const handler = createHandler();
    const result = await handler.handle({});

    expect(result).toEqual({
      sampleSize: 10,
      applied: false,
      safetyPassed: false,
      dryRun: true,
    });
  });
});
