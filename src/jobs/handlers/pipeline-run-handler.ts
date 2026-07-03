import type { PipelineRunService } from '../../app/pipeline-run-service.js';
import type { PipelineRunPayload, PipelineRunResult, JobHandler } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface PipelineRunHandlerDeps {
  runService: PipelineRunService;
}

export class PipelineRunHandler implements JobHandler<PipelineRunPayload, PipelineRunResult> {
  readonly jobType = 'PIPELINE_RUN' as const;

  constructor(private readonly deps: PipelineRunHandlerDeps) {}

  async handle(payload: PipelineRunPayload): Promise<PipelineRunResult> {
    const { candidateGenerationInput, runId } = payload;

    logger.info({ runId }, 'PipelineRunHandler: starting pipeline run');

    const result = await this.deps.runService.runSync(candidateGenerationInput, {
      externalRunId: runId,
    });

    logger.info(
      {
        runId: result.runId,
        recommended: result.recommended.length,
        durationMs: result.totalDurationMs,
      },
      'PipelineRunHandler: pipeline run completed',
    );

    return {
      runId: result.runId,
      recommended: result.recommended.length,
      scored: result.scored.length,
      totalDurationMs: result.totalDurationMs,
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
