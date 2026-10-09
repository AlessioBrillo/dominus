// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
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
    private readonly keyManager: KeyManager | undefined,
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

    if (!this.keyManager) throw new Error('API key management is not available');
    const apiKey = await this.keyManager.generate({
      tenantId,
      name: input.name,
      role: 'admin',
    });

    return { tenantId, apiKey };
  }

  /**
   * First sign-in of an OIDC user who belongs to no team: create their tenant
   * (free plan) with them as the active admin seat. No API key is minted —
   * the user authenticates through the SSO session; keys are created later
   * from Settings if they want machine access.
   */
  async provisionTenantForUser(userId: string): Promise<{ tenantId: string }> {
    // Derived from the user, not random: two concurrent first callbacks (a
    // double-clicked login) converge on the same tenant instead of creating two.
    const tenantId = `tenant-${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
    const existing = await this.teamSeatsRepo.findByTenantAndUser(tenantId, userId);
    if (existing?.status === 'active') return { tenantId };
    await this.subscriptionRepo.ensureDefault(tenantId);
    await this.teamSeatsRepo.invite(tenantId, userId, 'admin', userId);
    await this.teamSeatsRepo.acceptInvite(tenantId, userId);
    return { tenantId };
  }
}
