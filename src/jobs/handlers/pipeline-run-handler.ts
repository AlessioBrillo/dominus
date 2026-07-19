import type { PipelineRunService } from '../../app/pipeline-run-service.js';
import type { JobHandler } from '../../types/job-queue.js';
import type { PipelineRunPayload, PipelineRunResult } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface PipelineRunHandlerDeps {
  runService: PipelineRunService;
}

export class PipelineRunHandler implements JobHandler<PipelineRunPayload, PipelineRunResult> {
  readonly jobType = 'PIPELINE_RUN' as const;

  constructor(private readonly deps: PipelineRunHandlerDeps) {}

  async handle(payload: PipelineRunPayload, signal?: AbortSignal): Promise<PipelineRunResult> {
    const { candidateGenerationInput, runId } = payload;

    logger.info({ runId }, 'PipelineRunHandler: starting pipeline run');

    const result = await this.deps.runService.runSync(candidateGenerationInput, {
      externalRunId: runId,
      ...(signal !== undefined ? { signal } : {}),
    });

    logger.info(
      {
        runId: result.runId,
        recommended: result.recommended.length,
        scored: result.scored.length,
        durationMs: result.totalDurationMs,
        degraded: result.degraded,
        stageErrors: result.stageErrors.length,
      },
      'PipelineRunHandler: pipeline run completed',
    );

    return {
      runId: result.runId,
      recommended: result.recommended.length,
      scored: result.scored.length,
      totalDurationMs: result.totalDurationMs,
      degraded: result.degraded,
      stageErrors: result.stageErrors.map((e: unknown) =>
        typeof e === 'object' && e !== null
          ? JSON.stringify({
              stageName: (e as { stageName?: string }).stageName,
              message:
                typeof (e as { message?: unknown }).message === 'string'
                  ? (e as { message: string }).message
                  : String(e),
              provider: (e as { provider?: unknown }).provider,
              isTransient: (e as { isTransient?: unknown }).isTransient,
            })
          : String(e),
      ),
    };
  }
}
