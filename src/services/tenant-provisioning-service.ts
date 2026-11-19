// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { KeyManager, GeneratedKeyResult } from '../providers/auth/auth-provider.js';

export interface ProvisionedTenant {
  tenantId: string;
}

/**
 * Self-serve tenant provisioning for the Cloud edition: creates a fresh
 * tenant with a free subscription and the owner seat.
 *
 * The owner seat is stored with the email as user_id, so operators can
 * reach the owner for billing/support without a schema change.
 *
 * The seat is created PENDING and no API key is issued: the address was
 * never proven, and a key handed to whoever typed an address is a key
 * handed to whoever typed it first. The seat is activated (and the key
 * issued) by the email verification flow — see EmailVerificationService.
 */
export class TenantProvisioningService {
  constructor(
    private readonly subscriptionRepo: SubscriptionRepository,
    private readonly teamSeatsRepo: TeamSeatsRepository,
    private readonly keyManager: KeyManager | undefined,
  ) {}

  async provisionTenant(input: { name: string; email: string }): Promise<ProvisionedTenant> {
    const tenantId = `tenant-${randomBytes(8).toString('hex')}`;
    const ownerId = input.email.trim().toLowerCase();

    await this.subscriptionRepo.ensureDefault(tenantId);
    // Pending, not active: an active seat is one the identity resolver may
    // re-link to a single-sign-on identity.
    await this.teamSeatsRepo.invite(tenantId, ownerId, 'admin', ownerId);

    return { tenantId };
  }

  /**
   * Activate the owner seat and issue the first API key.
   *
   * Used by the verification flow (the address is proven) and by the
   * deployments that run without an email transport (the address is never
   * proven, so the seat stays unverified and cannot be claimed through
   * single sign-on).
   */
  async activateOwner(input: {
    tenantId: string;
    email: string;
    name: string;
  }): Promise<GeneratedKeyResult> {
    const ownerId = input.email.trim().toLowerCase();
    await this.teamSeatsRepo.acceptInvite(input.tenantId, ownerId);
    if (!this.keyManager) throw new Error('API key management is not available');
    return this.keyManager.generate({
      tenantId: input.tenantId,
      name: input.name,
      role: 'admin',
    });
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
