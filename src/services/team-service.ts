// SPDX-License-Identifier: AGPL-3.0-only
import type { TeamSeatsRepository } from '../db/repositories/team-seats-repository.js';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { TeamRole } from '../types/team.js';
import { TEAM_PLAN_LIMITS } from '../types/team.js';
import type { SubscriptionPlan } from '../types/subscription.js';

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
  seatLimit: number;
  activeSeats: number;
  pendingSeats: number;
  members: TeamMember[];
}

export class TeamService {
  readonly #seatsRepo: TeamSeatsRepository;
  readonly #subRepo: SubscriptionRepository;

  constructor(seatsRepo: TeamSeatsRepository, subRepo: SubscriptionRepository) {
    this.#seatsRepo = seatsRepo;
    this.#subRepo = subRepo;
  }

  async getTeamSummary(tenantId: string): Promise<TeamSummary> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan: SubscriptionPlan = sub?.plan ?? 'free';
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
      seatLimit: limits.seats,
      activeSeats: seats.filter((s) => s.status === 'active').length,
      pendingSeats: seats.filter((s) => s.status === 'pending').length,
      members,
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
    const plan: SubscriptionPlan = sub?.plan ?? 'free';
    const limits = TEAM_PLAN_LIMITS[plan];

    if (limits.seats === 0) {
      throw new Error('Current plan does not support team seats');
    }

    const existing = await this.#seatsRepo.findByTenantAndUser(tenantId, userId);
    if (existing && existing.status === 'active') {
      throw new DuplicateSeatError(userId);
    }

    const activeCount = await this.#seatsRepo.countActiveSeats(tenantId);
    if (activeCount >= limits.seats) {
      throw new TeamSeatLimitError(activeCount, limits.seats);
    }

    await this.#seatsRepo.invite(tenantId, userId, role, invitedBy);
  }

  async acceptInvite(tenantId: string, userId: string): Promise<void> {
    const seat = await this.#seatsRepo.findByTenantAndUser(tenantId, userId);
    if (!seat) {
      throw new SeatNotFoundError(userId);
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
    const plan: SubscriptionPlan = sub?.plan ?? 'free';
    const limits = TEAM_PLAN_LIMITS[plan];

    if (limits.seats === 0) return false;

    const activeCount = await this.#seatsRepo.countActiveSeats(tenantId);
    return activeCount < limits.seats;
  }
}
