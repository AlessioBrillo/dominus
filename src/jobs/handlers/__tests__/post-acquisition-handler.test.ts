// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { PostAcquisitionHandler } from '../post-acquisition-handler.js';

describe('PostAcquisitionHandler', () => {
  function mockService(): {
    run: ReturnType<typeof vi.fn>;
  } {
    return {
      run: vi.fn().mockResolvedValue({
        domain: 'example.com',
        source: 'purchase',
        enabled: true,
        dryRun: true,
        steps: [
          { step: 'portfolio', status: 'skipped', message: 'no executor registered' },
          { step: 'listing', status: 'done', message: 'listed on manual' },
        ],
      }),
    };
  }

  it('has the POST_ACQUISITION job type', () => {
    const handler = new PostAcquisitionHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postAcquisitionService: mockService() as any,
    });
    expect(handler.jobType).toBe('POST_ACQUISITION');
  });

  it('runs the pipeline for the payload domain and summarises steps', async () => {
    const service = mockService();
    const handler = new PostAcquisitionHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postAcquisitionService: service as any,
    });

    const result = await handler.handle({ domain: 'example.com', source: 'purchase' });

    expect(service.run).toHaveBeenCalledWith('example.com', 'purchase', expect.anything());
    expect(result.done).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.enabled).toBe(true);
  });

  it('falls back to the purchase source for unknown sources', async () => {
    const service = mockService();
    const handler = new PostAcquisitionHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postAcquisitionService: service as any,
    });

    await handler.handle({ domain: 'example.com', source: 'bogus' });
    expect(service.run).toHaveBeenCalledWith('example.com', 'purchase', expect.anything());
  });

  it('forwards the pipeline run id and the abort signal', async () => {
    const service = mockService();
    const handler = new PostAcquisitionHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      postAcquisitionService: service as any,
    });
    const controller = new AbortController();

    await handler.handle(
      { domain: 'example.com', source: 'pipeline_run', pipelineRunId: 'run-42' },
      controller.signal,
    );

    expect(service.run).toHaveBeenCalledWith('example.com', 'pipeline_run', {
      signal: controller.signal,
      pipelineRunId: 'run-42',
    });
  });
});
