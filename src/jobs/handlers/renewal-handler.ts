import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';
import type { RenewalCheckPayload, RenewalCheckResult, JobHandler } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface RenewalHandlerDeps {
  alertEngine: RenewalAlertEngine;
}

export class RenewalCheckHandler implements JobHandler<RenewalCheckPayload, RenewalCheckResult> {
  readonly jobType = 'RENEWAL_CHECK' as const;

  constructor(private readonly deps: RenewalHandlerDeps) {}

  async handle(_payload: RenewalCheckPayload): Promise<RenewalCheckResult> {
    logger.info('RenewalCheckHandler: starting renewal check');
    const result = await this.deps.alertEngine.checkAll();
    return {
      alertsCreated: result.generated,
      alertsAcknowledged: 0,
      domainsChecked: result.alerts.length,
    };
  }
}
