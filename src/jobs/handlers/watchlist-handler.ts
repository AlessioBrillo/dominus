import type { WatchlistService } from '../../watchlist/watchlist-service.js';
import type {
  WatchlistPollPayload,
  WatchlistPollResult,
  JobHandler,
} from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface WatchlistHandlerDeps {
  watchlistService: WatchlistService;
}

export class WatchlistPollHandler implements JobHandler<WatchlistPollPayload, WatchlistPollResult> {
  readonly jobType = 'WATCHLIST_POLL' as const;

  constructor(private readonly deps: WatchlistHandlerDeps) {}

  async handle(_payload: WatchlistPollPayload): Promise<WatchlistPollResult> {
    logger.debug('WatchlistPollHandler: starting poll');
    const result = await this.deps.watchlistService.poll();
    logger.info(
      {
        checked: result.checked,
        available: result.available,
        notified: result.notified,
        errors: result.errors,
      },
      'WatchlistPollHandler: completed',
    );
    return result;
  }
}
