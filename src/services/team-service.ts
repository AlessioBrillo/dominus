// SPDX-License-Identifier: AGPL-3.0-only
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import { createHash, randomBytes } from 'node:crypto';
import type {
  TeamInvitation,
  TeamInvitationsRepository,
} from '../db/repositories/team-invitations-repository.js';
import type { Mailer } from '../providers/email/mailer.js';
import { getLogger } from '../logger.js';
import type { TeamRole } from '../types/team.js';
import { TEAM_PLAN_LIMITS } from '../types/team.js';
import type { Subscription, SubscriptionPlan } from '../types/subscription.js';
import { effectivePlanFor } from './effective-plan.js';

export class TeamSeatLimitError extends Error {
  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`Team seat limit reached (${current}/${limit})`);
    this.name = 'TeamSeatLimitError';
  }
}

export class DuplicateSeatError extends Error {
  constructor(public readonly userId: string) {
    super(`User ${userId} already has a seat in this team`);
    this.name = 'DuplicateSeatError';
  }
}

/** The token is unknown, expired, revoked or already used (deliberately not distinguished). */
export class InvitationInvalidError extends Error {
  constructor() {
    super('Invitation is invalid, expired or already used');
    this.name = 'InvitationInvalidError';
  }
}

export class SeatNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`Seat not found for user ${userId}`);
    this.name = 'SeatNotFoundError';
  }
}

export interface TeamMember {
  userId: string;
  role: TeamRole;
  status: string;
  invitedAt: string;
  joinedAt: string | null;
}

export interface TeamSummary {
  tenantId: string;
  plan: SubscriptionPlan;
  /** Maximum active seats; null when the plan is unlimited (enterprise). */
  seatLimit: number | null;
  activeSeats: number;
  pendingSeats: number;
  members: TeamMember[];
  /** Outstanding email invitations (they hold a seat until accepted/expired). */
  invitations: Omit<TeamInvitation, 'tenantId' | 'acceptedAt'>[];
}

export interface InvitationOptions {
  repo: TeamInvitationsRepository;
  /** Optional: without a configured mailer the caller gets a link to share. */
  mailer?: Mailer | undefined;
  /** Public origin used to build the invitation link (PUBLIC_APP_URL). */
  appUrl?: string | undefined;
  /** Invitation lifetime in hours (default 7 days). */
  ttlHours?: number | undefined;
}

export interface CreatedInvitation {
  invitation: TeamInvitation;
  /** Single-use link. Shown once: only its hash is stored. */
  link: string;
  emailed: boolean;
}

const logger = getLogger();
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface TeamServiceOptions {
  /**
   * Operator plan override lookup (ADR-0057), same contract as
   * UsageMeterService: when the provider returns a non-null plan it wins
   * over the subscription-derived effective plan, so an operator grant
   * (enterprise trial, SLA compensation) raises seat limits exactly like
   * usage limits — the two enforcement surfaces must never disagree.
   */
  planOverrideProvider?: (tenantId: string) => Promise<SubscriptionPlan | null>;
  /** Email-addressed invitations. Omitted = only the legacy user-id seat flow. */
  invitations?: InvitationOptions;
}

export class TeamService {
  readonly #seatsRepo: TeamSeatsRepository;
  readonly #subRepo: SubscriptionRepository;
  readonly #invitations: InvitationOptions | undefined;
  readonly #planOverrideProvider:
    ((tenantId: string) => Promise<SubscriptionPlan | null>) | undefined;

  constructor(
    seatsRepo: TeamSeatsRepository,
    subRepo: SubscriptionRepository,
    options: TeamServiceOptions = {},
  ) {
    this.#seatsRepo = seatsRepo;
    this.#subRepo = subRepo;
    this.#planOverrideProvider = options.planOverrideProvider;
    this.#invitations = options.invitations;
  }

  /** Seats held by active members, legacy pending seats and outstanding invitations. */
  async #occupiedSeats(tenantId: string): Promise<number> {
    const seats = await this.#seatsRepo.countOccupiedSeats(tenantId);
    const invited = this.#invitations ? await this.#invitations.repo.countPending(tenantId) : 0;
    return seats + invited;
  }

  /** Effective plan for a tenant: operator override first, then subscription. */
  async #resolvePlan(
    tenantId: string,
    sub: Subscription | null | undefined,
  ): Promise<SubscriptionPlan> {
    const override = this.#planOverrideProvider ? await this.#planOverrideProvider(tenantId) : null;
    return effectivePlanFor(sub, override);
  }

  async getTeamSummary(tenantId: string): Promise<TeamSummary> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan = await this.#resolvePlan(tenantId, sub);
    const limits = TEAM_PLAN_LIMITS[plan];
    const seats = await this.#seatsRepo.findByTenantId(tenantId);

    const members: TeamMember[] = seats.map((s) => ({
      userId: s.userId,
      role: s.role,
      status: s.status,
      invitedAt: s.invitedAt,
      joinedAt: s.joinedAt,
    }));

    return {
      tenantId,
      plan,
      seatLimit: Number.isFinite(limits.seats) ? limits.seats : null,
      activeSeats: seats.filter((s) => s.status === 'active').length,
      pendingSeats: seats.filter((s) => s.status === 'pending').length,
      members,
      invitations: (this.#invitations
        ? await this.#invitations.repo.listPending(tenantId)
        : []
      ).map(({ id, email, role, invitedBy, expiresAt, createdAt }) => ({
        id,
        email,
        role,
        invitedBy,
        expiresAt,
        createdAt,
      })),
    };
  }

  async inviteMember(
    tenantId: string,
    userId: string,
    role: TeamRole,
    invitedBy: string,
  ): Promise<void> {
    if (role === 'owner') {
      throw new Error('Cannot assign owner role via invitation');
    }

    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan = await this.#resolvePlan(tenantId, sub);
    const limits = TEAM_PLAN_LIMITS[plan];

    if (limits.seats === 0) {
      throw new Error('Current plan does not support team seats');
    }

    const existing = await this.#seatsRepo.findByTenantAndUser(tenantId, userId);
    if (existing && existing.status === 'active') {
      throw new DuplicateSeatError(userId);
    }

    // Pending invitations hold a seat, otherwise N invites could be issued
    // and accepted past the plan limit.
    const occupied = await this.#occupiedSeats(tenantId);
    const isReinvite = existing?.status === 'pending';
    if (!isReinvite && occupied >= limits.seats) {
      throw new TeamSeatLimitError(occupied, limits.seats);
    }

    await this.#seatsRepo.invite(tenantId, userId, role, invitedBy);
  }

  async acceptInvite(tenantId: string, userId: string): Promise<void> {
    const seat = await this.#seatsRepo.findByTenantAndUser(tenantId, userId);
    if (!seat) {
      throw new SeatNotFoundError(userId);
    }
    if (seat.status !== 'active') {
      const sub = await this.#subRepo.findByTenantId(tenantId);
      const limits = TEAM_PLAN_LIMITS[await this.#resolvePlan(tenantId, sub)];
      const active = await this.#seatsRepo.countActiveSeats(tenantId);
      if (active >= limits.seats) {
        throw new TeamSeatLimitError(active, limits.seats);
      }
    }
    await this.#seatsRepo.acceptInvite(tenantId, userId);
  }

  async updateMemberRole(tenantId: string, userId: string, role: TeamRole): Promise<void> {
    const seat = await this.#seatsRepo.findByTenantAndUser(tenantId, userId);
    if (!seat || seat.status !== 'active') {
      throw new SeatNotFoundError(userId);
    }
    await this.#seatsRepo.updateRole(tenantId, userId, role);
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    const seat = await this.#seatsRepo.findByTenantAndUser(tenantId, userId);
    if (!seat) {
      throw new SeatNotFoundError(userId);
    }
    await this.#seatsRepo.remove(tenantId, userId);
  }

  async canAddSeat(tenantId: string): Promise<boolean> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan = await this.#resolvePlan(tenantId, sub);
    const limits = TEAM_PLAN_LIMITS[plan];

    if (limits.seats === 0) return false;

    const occupied = await this.#occupiedSeats(tenantId);
    return occupied < limits.seats;
  }

  /**
   * Invite someone by email. Creates a single-use token (only its SHA-256 is
   * stored), reserves a seat until it is accepted or expires, and emails the
   * link when SMTP is configured. The link is always returned so an admin can
   * share it by hand when email is off.
   */
  async createInvitation(
    tenantId: string,
    email: string,
    role: TeamRole,
    invitedBy: string,
  ): Promise<CreatedInvitation> {
    const inv = this.#invitations;
    if (!inv) throw new Error('Email invitations are not enabled');
    if (role === 'owner') throw new Error('Cannot assign owner role via invitation');

    const sub = await this.#subRepo.findByTenantId(tenantId);
    const limits = TEAM_PLAN_LIMITS[await this.#resolvePlan(tenantId, sub)];
    if (limits.seats === 0) throw new Error('Current plan does not support team seats');

    const occupied = await this.#occupiedSeats(tenantId);
    if (occupied >= limits.seats) throw new TeamSeatLimitError(occupied, limits.seats);

    const token = randomBytes(32).toString('base64url');
    const ttlMs = (inv.ttlHours ?? 168) * 3_600_000;
    const invitation = await inv.repo.create({
      tenantId,
      email: email.trim().toLowerCase(),
      role,
      tokenHash: hashToken(token),
      invitedBy,
      expiresAt: new Date(Date.now() + ttlMs),
    });

    const base = (inv.appUrl ?? '').replace(/\/+$/, '');
    const link = `${base}/invite/${token}`;

    let emailed = false;
    if (inv.mailer?.configured) {
      try {
        await inv.mailer.send({
          to: invitation.email,
          subject: 'You have been invited to a DOMINUS team',
          text:
            `You were invited to join a DOMINUS team as ${role}.\n\n` +
            `Accept the invitation (valid for ${Math.round(ttlMs / 3_600_000)} hours):\n${link}\n\n` +
            `If you were not expecting this, ignore this email.`,
        });
        emailed = true;
      } catch (err) {
        // The invitation is valid; the admin can still share the link.
        logger.warn({ err, tenantId, invitationId: invitation.id }, 'Invitation email failed');
      }
    }
    return { invitation, link, emailed };
  }

  async revokeInvitation(tenantId: string, invitationId: number): Promise<boolean> {
    return this.#invitations ? this.#invitations.repo.revoke(tenantId, invitationId) : false;
  }

  /**
   * Redeem an invitation for the signed-in user. The token is claimed
   * atomically first (so a link works once even under concurrent clicks) and
   * the claim is rolled back if the seat cannot be created.
   */
  async acceptInvitation(
    token: string,
    userId: string,
  ): Promise<{ tenantId: string; role: TeamRole }> {
    const inv = this.#invitations;
    if (!inv) throw new InvitationInvalidError();

    const invitation = await inv.repo.findByTokenHash(hashToken(token));
    if (
      !invitation ||
      invitation.acceptedAt !== null ||
      new Date(invitation.expiresAt).getTime() <= Date.now()
    ) {
      throw new InvitationInvalidError();
    }
    if (!(await inv.repo.claim(invitation.id, userId))) throw new InvitationInvalidError();

    try {
      const { tenantId, role } = invitation;
      const existing = await this.#seatsRepo.findByTenantAndUser(tenantId, userId);
      if (existing?.status !== 'active') {
        const sub = await this.#subRepo.findByTenantId(tenantId);
        const limits = TEAM_PLAN_LIMITS[await this.#resolvePlan(tenantId, sub)];
        const active = await this.#seatsRepo.countActiveSeats(tenantId);
        if (active >= limits.seats) throw new TeamSeatLimitError(active, limits.seats);
        await this.#seatsRepo.invite(tenantId, userId, role, invitation.invitedBy ?? userId);
        await this.#seatsRepo.acceptInvite(tenantId, userId);
      }
      return { tenantId, role: existing?.status === 'active' ? existing.role : role };
    } catch (err) {
      await inv.repo.unclaim(invitation.id);
      throw err;
    }
  }
}
