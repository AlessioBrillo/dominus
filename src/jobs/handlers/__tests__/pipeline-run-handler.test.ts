/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { PipelineRunHandler } from '../pipeline-run-handler.js';
import type { PipelineRunPayload, PipelineRunResult } from '../../../types/job-queue.js';

describe('PipelineRunHandler', () => {
  it('calls runService.run and returns formatted result', async () => {
    const runService = {
      run: vi.fn().mockResolvedValue({
        runId: 'run-abc',
        recommended: [{}],
        scored: [{}, {}],
        totalDurationMs: 1200,
        stageErrors: [],
      }),
    };
    const handler = new PipelineRunHandler({ runService } as any);

    const payload: PipelineRunPayload = {
      candidateGenerationInput: { keywords: ['test'] },
      runId: 'run-abc',
    };

    const result: PipelineRunResult = await handler.handle(payload);

    expect(runService.run).toHaveBeenCalledWith({ keywords: ['test'] });
    expect(result.runId).toBe('run-abc');
    expect(result.recommended).toBe(1);
    expect(result.scored).toBe(2);
    expect(result.totalDurationMs).toBe(1200);
    expect(result.stageErrors).toEqual([]);
    expect(handler.jobType).toBe('PIPELINE_RUN');
  });

  it('stringifies stage errors', async () => {
    const runService = {
      run: vi.fn().mockResolvedValue({
        runId: 'run-err',
        recommended: [],
        scored: [],
        totalDurationMs: 500,
        stageErrors: [new Error('boom')],
      }),
    };
    const handler = new PipelineRunHandler({ runService } as any);

    const result = await handler.handle({
      candidateGenerationInput: {},
      runId: 'run-err',
    });

    expect(result.stageErrors).toEqual(['Error: boom']);
  });
});
