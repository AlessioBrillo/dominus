// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PostAcquisitionPayload,
  PostAcquisitionResult,
  JobHandler,
} from '../../types/job-queue.js';
import {
  isPostAcquisitionTriggerSource,
  type PostAcquisitionTriggerSource,
} from '../../types/automation.js';
import type { PostAcquisitionService } from '../../services/post-acquisition-service.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface PostAcquisitionHandlerDeps {
  postAcquisitionService: PostAcquisitionService;
}

/**
 * Handles POST_ACQUISITION jobs — runs the automated post-purchase pipeline
 * (ADR-0083) asynchronously so the purchase/auction completion path never
 * blocks on external APIs.
 *
 * The service is journaled and idempotent: a retried job resumes where the
 * previous attempt stopped instead of repeating completed steps.
 */
export class PostAcquisitionHandler implements JobHandler<
  PostAcquisitionPayload,
  PostAcquisitionResult
> {
  readonly jobType = 'POST_ACQUISITION' as const;

  constructor(private readonly deps: PostAcquisitionHandlerDeps) {}

  async handle(
    payload: PostAcquisitionPayload,
    signal?: AbortSignal,
  ): Promise<PostAcquisitionResult> {
    const source: PostAcquisitionTriggerSource = isPostAcquisitionTriggerSource(payload.source)
      ? payload.source
      : 'purchase';

    logger.info({ domain: payload.domain, source }, 'PostAcquisitionHandler: starting');

    const result = await this.deps.postAcquisitionService.run(payload.domain, source, {
      ...(signal ? { signal } : {}),
      ...(payload.pipelineRunId != null ? { pipelineRunId: payload.pipelineRunId } : {}),
    });

    const summary = {
      domain: result.domain,
      source: result.source,
      enabled: result.enabled,
      dryRun: result.dryRun,
      steps: result.steps.map((s) => ({
        step: s.step,
        status: s.status,
        ...(s.message !== undefined ? { message: s.message } : {}),
      })),
      done: result.steps.filter((s) => s.status === 'done').length,
      skipped: result.steps.filter((s) => s.status === 'skipped').length,
      failed: result.steps.filter((s) => s.status === 'failed').length,
    };

    logger.info(
      {
        domain: payload.domain,
        done: summary.done,
        skipped: summary.skipped,
        failed: summary.failed,
      },
      'PostAcquisitionHandler: complete',
    );

    return summary;
  }
}
