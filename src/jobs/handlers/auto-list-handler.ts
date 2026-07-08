import type { AutoListPayload, AutoListResultData, JobHandler } from '../../types/job-queue.js';
import type { AutoListingService, AutoListSource } from '../../services/auto-listing-service.js';
import type { ScoreResult } from '../../types/score.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface AutoListHandlerDeps {
  autoListingService: AutoListingService;
}

/**
 * Handles AUTO_LIST jobs — processes post-pipeline auto-listing asynchronously
 * so the pipeline completion hook doesn't block on marketplace API calls.
 *
 * The handler receives the list of recommended domains with their score
 * snapshots (serialized as JSON) and submits them to the configured
 * marketplace. This is fire-and-forget: errors are logged but never
 * bubble up to block the job queue.
 */
export class AutoListHandler implements JobHandler<AutoListPayload, AutoListResultData> {
  readonly jobType = 'AUTO_LIST' as const;

  constructor(private readonly deps: AutoListHandlerDeps) {}

  async handle(payload: AutoListPayload, _signal?: AbortSignal): Promise<AutoListResultData> {
    logger.info(
      { domainCount: payload.domains.length, source: payload.source },
      'AutoListHandler: starting',
    );

    const source: AutoListSource = isAutoListSource(payload.source)
      ? payload.source
      : 'pipeline_run';
    const domains = payload.domains.map((d) => ({
      domain: d.domain,
      score: parseScore(d.scoreJson),
    }));

    const { listed, skipped } = await this.deps.autoListingService.autoListBatch(
      domains,
      source,
      payload.pipelineRunId,
    );

    logger.info({ listed: listed.length, skipped: skipped.length }, 'AutoListHandler: complete');

    return {
      listed: listed.length,
      skipped: skipped.length,
      errors: skipped.filter((s) => s.reason === 'error').length,
    };
  }
}

const AUTO_LIST_SOURCES: readonly AutoListSource[] = [
  'acquisition',
  'purchase',
  'pipeline_run',
  'manual',
] as const;

function isAutoListSource(value: string): value is AutoListSource {
  return (AUTO_LIST_SOURCES as readonly string[]).includes(value);
}

function parseScore(json: string | null): ScoreResult | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as ScoreResult;
  } catch {
    return null;
  }
}
