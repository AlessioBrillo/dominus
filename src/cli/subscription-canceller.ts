// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../config.js';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import { WebhookEventsRepository } from '../db/repositories/webhook-events-repository.js';
import { CustomPriceRepository } from '../db/repositories/custom-price-repository.js';
import { BillingService } from '../services/billing-service.js';

/**
 * The function that stops the invoice when a tenant is erased from the
 * command line.
 *
 * The data of a tenant lives in the database, the invoice lives in the
 * payment provider: erasing the rows without cancelling the subscription
 * leaves a deleted account on the monthly invoice. The CLI is one of the
 * two ways to erase a tenant (the API is the other), so it cancels too.
 */
export function buildCliSubscriptionCanceller(
  provider: DatabaseProvider,
  config: Config,
): (tenantId: string) => Promise<boolean> {
  const billing = new BillingService(
    config,
    new SubscriptionRepository(provider),
    new WebhookEventsRepository(provider),
    new CustomPriceRepository(provider),
  );
  return (tenantId: string) => billing.cancelSubscriptionForTenant(tenantId);
}
