import type {
  PortfolioHealthcheckPayload,
  PortfolioHealthcheckResult,
  JobHandler,
} from '../../types/job-queue.js';
import type { PortfolioRdapService } from '../../portfolio/portfolio-rdap-service.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface PortfolioHealthcheckHandlerDeps {
  healthcheckService: PortfolioRdapService;
}

/**
 * Handles PORTFOLIO_HEALTHCHECK jobs.
 * Verifies portfolio domains against live RDAP/WHOIS data to detect
 * expiry date changes and keep renewal tracking up to date.
 */
export class PortfolioHealthcheckHandler implements JobHandler<
  PortfolioHealthcheckPayload,
  PortfolioHealthcheckResult
> {
  readonly jobType = 'PORTFOLIO_HEALTHCHECK' as const;

  constructor(private readonly deps: PortfolioHealthcheckHandlerDeps) {}

  async handle(
    payload: PortfolioHealthcheckPayload,
    signal?: AbortSignal,
  ): Promise<PortfolioHealthcheckResult> {
    logger.info(
      { horizonDays: payload.horizonDays, batchSize: payload.batchSize },
      'PortfolioHealthcheckHandler: starting',
    );

    const result = await this.deps.healthcheckService.checkExpiring(
      payload.horizonDays ?? 90,
      payload.batchSize ?? 100,
      signal,
    );

    logger.info(
      { checked: result.checked, updated: result.updated, errors: result.errors },
      'PortfolioHealthcheckHandler: complete',
    );

    return {
      checked: result.checked,
      updated: result.updated,
      errors: result.errors,
    };
  }
}
