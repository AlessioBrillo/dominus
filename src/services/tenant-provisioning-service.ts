// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { KeyManager, GeneratedKeyResult } from '../providers/auth/auth-provider.js';

export interface ProvisionedTenant {
  tenantId: string;
  apiKey: GeneratedKeyResult;
}

/**
 * Self-serve tenant provisioning for the Cloud edition: creates a fresh
 * tenant with a free subscription, an active owner seat, and the first
 * admin API key (shown exactly once). This is the customer-acquisition
 * path — without it tenants only appear implicitly via auto-provision.
 *
 * The owner seat is stored with the email as user_id, so operators can
 * reach the owner for billing/support without a schema change.
 */
export class TenantProvisioningService {
  constructor(
    private readonly subscriptionRepo: SubscriptionRepository,
    private readonly teamSeatsRepo: TeamSeatsRepository,
    private readonly keyManager: KeyManager,
  ) {}

  async provisionTenant(input: {
    name: string;
    email?: string | undefined;
  }): Promise<ProvisionedTenant> {
    const tenantId = `tenant-${randomBytes(8).toString('hex')}`;
    const ownerId = input.email ?? `${tenantId}-owner`;

    await this.subscriptionRepo.ensureDefault(tenantId);
    await this.teamSeatsRepo.invite(tenantId, ownerId, 'admin', ownerId);
    await this.teamSeatsRepo.acceptInvite(tenantId, ownerId);

    const apiKey = await this.keyManager.generate({
      tenantId,
      name: input.name,
      role: 'admin',
    });

    return { tenantId, apiKey };
  }
}
