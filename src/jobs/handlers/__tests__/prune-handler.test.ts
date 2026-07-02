/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { PruneHandler } from '../prune-handler.js';

describe('PruneHandler', () => {
   
  function makeDeps(overrides: Record<string, unknown> = {}): any {
    return {
      candidateRepo: { pruneRescoreCandidates: vi.fn().mockReturnValue(10) },
      scoringRepo: { pruneByRunIdPrefix: vi.fn().mockReturnValue(5) },
      pipelineRunsRepo: { pruneBefore: vi.fn().mockReturnValue(3) },
      providerCacheRepo: { pruneExpired: vi.fn().mockReturnValue(20) },
      jobQueueRepo: { deleteCompleted: vi.fn().mockReturnValue(7) },
      provider: { exec: vi.fn().mockResolvedValue({ changes: 2 }) },
      publicScoresRetentionDays: 90,
      eventsRetentionDays: 180,
      ...overrides,
    };
  }

  it('calls all repositories to prune expired data', async () => {
    const deps = makeDeps();
    const handler = new PruneHandler(deps as any);

    const result = await handler.handle({ maxAgeDays: 30 });

    expect(deps.candidateRepo.pruneRescoreCandidates).toHaveBeenCalled();
    expect(deps.scoringRepo.pruneByRunIdPrefix).toHaveBeenCalled();
    expect(deps.pipelineRunsRepo.pruneBefore).toHaveBeenCalled();
    expect(deps.providerCacheRepo.pruneExpired).toHaveBeenCalled();
    expect(deps.jobQueueRepo.deleteCompleted).toHaveBeenCalled();
    expect(deps.provider.exec).toHaveBeenCalledTimes(2);
    expect(result.deletedCandidates).toBe(10);
    expect(result.deletedScoringRuns).toBe(5);
    expect(result.deletedPipelineRuns).toBe(3);
    expect(result.deletedProviderCache).toBe(20);
    expect(result.deletedJobQueue).toBe(7);
    expect(result.deletedWaybackCache).toBe(0);
    expect(result.deletedPublicScores).toBe(2);
    expect(result.deletedEvents).toBe(2);
  });

  it('uses default maxAgeDays of 30', async () => {
    const deps = makeDeps({
      candidateRepo: { pruneRescoreCandidates: vi.fn().mockReturnValue(0) },
    });
    const handler = new PruneHandler(deps as any);

    await handler.handle({});

    expect(deps.candidateRepo.pruneRescoreCandidates).toHaveBeenCalled();
  });

  it('has the correct jobType', () => {
    const handler = new PruneHandler({} as any);
    expect(handler.jobType).toBe('PRUNE');
  });
});
