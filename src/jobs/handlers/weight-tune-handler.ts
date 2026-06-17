import type { WeightTunePayload, WeightTuneResult, JobHandler } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface TuneableWeightTuner {
  tune(): { sampleSize: number; safety: { passed: boolean }; applied: boolean; dryRun: boolean };
}

export interface WeightTuneHandlerDeps {
  autoTuner: TuneableWeightTuner;
}

export class WeightTuneHandler implements JobHandler<WeightTunePayload, WeightTuneResult> {
  readonly jobType = 'WEIGHT_TUNE' as const;

  constructor(private readonly deps: WeightTuneHandlerDeps) {}

  async handle(_payload: WeightTunePayload): Promise<WeightTuneResult> {
    logger.info('WeightTuneHandler: starting weight tuning cycle');

    const outcome = await this.deps.autoTuner.tune();

    logger.info(
      {
        sampleSize: outcome.sampleSize,
        safetyPassed: outcome.safety.passed,
        applied: outcome.applied,
        dryRun: outcome.dryRun,
      },
      'WeightTuneHandler: completed',
    );

    return {
      sampleSize: outcome.sampleSize,
      applied: outcome.applied,
      safetyPassed: outcome.safety.passed,
      dryRun: outcome.dryRun,
    };
  }
}
