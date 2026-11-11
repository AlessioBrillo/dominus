// SPDX-License-Identifier: AGPL-3.0-only
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { TeamRole, TeamSeat } from '../types/team.js';
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
 *   1. an active seat          → that team (most recently joined), role from the seat
 *   2. a seat held by the email → that team, and the seat is re-linked to the
 *      identity-provider subject (the self-serve signup creates the owner
 *      seat with the email, because at that moment there is no subject yet)
 *   3. an IdP org_id           → that tenant, role from the token (Auth0 Organizations)
 *   4. neither                 → a fresh tenant with the user as admin, when
 *                                auto-provisioning is on
 *   5. otherwise               → unscoped (the auth layer then rejects it in cloud mode)
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
    email?: string | undefined;
  }): Promise<ResolvedIdentity> {
    const [seat] = await this.seats.findActiveByUserId(input.sub);
    if (seat) return { tenantId: seat.tenantId, role: sessionRoleFor(seat.role) };

    // The seat of a workspace created through the self-serve signup is held
    // by the EMAIL: at signup time there is no identity-provider subject.
    // When the same person signs in with single sign-on, the seat is
    // re-linked to the subject, so the person lands in the workspace they
    // created instead of a second, empty one.
    const byEmail = await this.#findSeatByEmail(input.email);
    if (byEmail) {
      await this.#relink(byEmail, input.sub);
      return { tenantId: byEmail.tenantId, role: sessionRoleFor(byEmail.role) };
    }

    if (input.orgId) return { tenantId: input.orgId, role: input.claimedRole };

    if (this.autoProvision && this.provisioning) {
      const { tenantId } = await this.provisioning.provisionTenantForUser(input.sub);
      return { tenantId, role: 'admin' };
    }
    return { tenantId: undefined, role: input.claimedRole };
  }

  /** The active seat whose user identifier is the given email, if any. */
  async #findSeatByEmail(email: string | undefined): Promise<TeamSeat | undefined> {
    if (!email) return undefined;
    const normalized = email.trim().toLowerCase();
    if (normalized === '') return undefined;
    const [seat] = await this.seats.findActiveByUserId(normalized);
    return seat;
  }

  /**
   * Move the seat from the email to the identity-provider subject. The
   * move is skipped when the subject already has a seat in that tenant
   * (the unique constraint would reject it, and the subject's own seat is
   * the one that must win).
   */
  async #relink(seat: TeamSeat, sub: string): Promise<void> {
    if (seat.userId === sub) return;
    const existing = await this.seats.findByTenantAndUser(seat.tenantId, sub);
    if (existing) return;
    await this.seats.relinkUser(seat.tenantId, seat.userId, sub);
  }
}
