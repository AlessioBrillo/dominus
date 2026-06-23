import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';
import type { PortfolioRescoreService } from '../../portfolio/portfolio-rescore-service.js';
import type {
  PortfolioRescorePayload,
  PortfolioRescoreResult,
  JobHandler,
} from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface PortfolioRescoreHandlerDeps {
  portfolioManager: PortfolioManager;
  rescoreService: PortfolioRescoreService;
}

export class PortfolioRescoreHandler implements JobHandler<
  PortfolioRescorePayload,
  PortfolioRescoreResult
> {
  readonly jobType = 'PORTFOLIO_RESCORE' as const;

  constructor(private readonly deps: PortfolioRescoreHandlerDeps) {}

  async handle(payload: PortfolioRescorePayload): Promise<PortfolioRescoreResult> {
    logger.info({ domain: payload.domain }, 'PortfolioRescoreHandler: starting rescore');

    let result;
    if (payload.domain) {
      const summaries = await this.deps.portfolioManager.list();
      const summary = summaries.find((s) => s.entry.domain === payload.domain);
      if (!summary) {
        return {
          rescored: 0,
          totalDurationMs: 0,
          errors: [{ domain: payload.domain, error: 'Not found in portfolio' }],
        };
      }
      result = await this.deps.rescoreService.rescore([summary.entry]);
    } else {
      result = await this.deps.portfolioManager.rescoreAll();
    }

    const errors = result.results
      .filter((r) => r.error)
      .map((r) => ({ domain: r.domain, error: r.error! }));

    logger.info(
      { rescored: result.results.length, errors: errors.length },
      'PortfolioRescoreHandler: completed',
    );
    return { rescored: result.results.length, totalDurationMs: result.totalDurationMs, errors };
  }
}
