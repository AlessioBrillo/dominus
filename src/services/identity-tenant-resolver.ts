// SPDX-License-Identifier: AGPL-3.0-only
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { TeamRole } from '../types/team.js';
import type { TenantProvisioningService } from './tenant-provisioning-service.js';

/** Request role for a team seat: owner/admin manage the tenant, members do not. */
export function sessionRoleFor(seatRole: TeamRole): 'admin' | 'member' {
  return seatRole === 'member' ? 'member' : 'admin';
}

export interface ResolvedIdentity {
  tenantId: string | undefined;
  role: string | undefined;
}

/**
 * Decides which tenant (and role) an OIDC user gets at sign-in. The team seat
 * is the source of truth for humans; the IdP only proves who they are.
 *
 *   1. an active seat  → that team (most recently joined), role from the seat
 *   2. an IdP org_id   → that tenant, role from the token (Auth0 Organizations)
 *   3. neither         → a fresh tenant with the user as admin, when
 *                        auto-provisioning is on
 *   4. otherwise       → unscoped (the auth layer then rejects it in cloud mode)
 */
export class IdentityTenantResolver {
  constructor(
    private readonly seats: TeamSeatsRepository,
    private readonly provisioning: TenantProvisioningService | undefined,
    private readonly autoProvision: boolean,
  ) {}

  /**
   * Live check of a session against the user's team seat in the session's tenant.
   * - active seat: valid, with the CURRENT role (a demotion applies immediately)
   * - removed or pending seat: invalid (a removed member loses access at once)
   * - no seat at all: sessions minted from an IdP organization claim have none, so
   *   the claims are trusted as before
   */
  async validateSession(claims: {
    sub: string;
    tenantId?: string | undefined;
  }): Promise<{ role?: string | undefined } | null> {
    if (!claims.tenantId) return {};
    const seat = await this.seats.findByTenantAndUser(claims.tenantId, claims.sub);
    if (!seat) return {};
    if (seat.status !== 'active') return null;
    return { role: sessionRoleFor(seat.role) };
  }

  async resolve(input: {
    sub: string;
    orgId?: string | undefined;
    claimedRole?: string | undefined;
  }): Promise<ResolvedIdentity> {
    const [seat] = await this.seats.findActiveByUserId(input.sub);
    if (seat) return { tenantId: seat.tenantId, role: sessionRoleFor(seat.role) };

    if (input.orgId) return { tenantId: input.orgId, role: input.claimedRole };

    if (this.autoProvision && this.provisioning) {
      const { tenantId } = await this.provisioning.provisionTenantForUser(input.sub);
      return { tenantId, role: 'admin' };
    }
    return { tenantId: undefined, role: input.claimedRole };
  }
}
