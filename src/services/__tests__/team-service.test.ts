// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { TeamSeatsRepository } from '../../db/repositories/team-seats-repository.js';
import { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import {
  TeamService,
  TeamSeatLimitError,
  DuplicateSeatError,
  SeatNotFoundError,
} from '../team-service.js';

describe('TeamService', () => {
  let db: SqliteProvider;
  let seatsRepo: TeamSeatsRepository;
  let subRepo: SubscriptionRepository;
  let service: TeamService;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    seatsRepo = new TeamSeatsRepository(db);
    subRepo = new SubscriptionRepository(db);
    service = new TeamService(seatsRepo, subRepo);
  });

  afterEach(async () => {
    await db.close();
  });

  describe('getTeamSummary', () => {
    it('returns free plan defaults for tenant without subscription', async () => {
      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('free');
      expect(summary.seatLimit).toBe(1);
      expect(summary.activeSeats).toBe(0);
      expect(summary.members).toHaveLength(0);
    });

    it('returns pro plan limits', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'pro', status: 'active' });
      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('pro');
      expect(summary.seatLimit).toBe(3);
    });

    it('returns team plan limits', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'active' });
      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('team');
      expect(summary.seatLimit).toBe(10);
    });

    it('returns enterprise plan limits (unlimited)', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'enterprise', status: 'active' });
      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('enterprise');
      expect(summary.seatLimit).toBeNull();
    });

    it('lists members with their status', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'active' });
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.inviteMember('tenant-1', 'user-2', 'admin', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');

      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.activeSeats).toBe(1);
      expect(summary.pendingSeats).toBe(1);
      expect(summary.members).toHaveLength(2);
    });
  });

  describe('inviteMember', () => {
    it('throws for owner role', async () => {
      await expect(service.inviteMember('tenant-1', 'user-1', 'owner', 'owner-1')).rejects.toThrow(
        'Cannot assign owner role via invitation',
      );
    });

    it('supports unlimited invites on enterprise', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'enterprise', status: 'active' });
      for (let i = 1; i <= 5; i++) {
        await service.inviteMember('tenant-1', `user-${i}`, 'member', 'owner-1');
      }
      expect(await service.canAddSeat('tenant-1')).toBe(true);
      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.pendingSeats).toBe(5);
    });

    it('throws DuplicateSeatError for already active member', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'pro', status: 'active' });
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');

      await expect(service.inviteMember('tenant-1', 'user-1', 'admin', 'owner-1')).rejects.toThrow(
        DuplicateSeatError,
      );
    });

    it('throws TeamSeatLimitError when seat limit reached', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'pro', status: 'active' });
      expect(await service.canAddSeat('tenant-1')).toBe(true);

      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');
      await service.inviteMember('tenant-1', 'user-2', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-2');
      await service.inviteMember('tenant-1', 'user-3', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-3');

      expect(await service.canAddSeat('tenant-1')).toBe(false);

      await expect(service.inviteMember('tenant-1', 'user-4', 'member', 'owner-1')).rejects.toThrow(
        TeamSeatLimitError,
      );
    });
  });

  describe('status-aware plan resolution (ADR-0053)', () => {
    it('downgrades past_due subscriptions to free seat limits', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'past_due' });
      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('free');
      expect(summary.seatLimit).toBe(1);
    });

    it('keeps trialing subscriptions on the paid plan', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'trialing' });
      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('team');
      expect(summary.seatLimit).toBe(10);
    });

    it('blocks invites at the free seat cap when billing lapsed', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'past_due' });
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');
      await expect(service.inviteMember('tenant-1', 'user-2', 'member', 'owner-1')).rejects.toThrow(
        TeamSeatLimitError,
      );
    });

    it('reports canAddSeat=false when the effective plan is free and the seat is taken', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'canceled' });
      expect(await service.canAddSeat('tenant-1')).toBe(true);
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');
      expect(await service.canAddSeat('tenant-1')).toBe(false);
    });
  });

  describe('acceptInvite', () => {
    it('throws SeatNotFoundError for non-existent invite', async () => {
      await expect(service.acceptInvite('tenant-1', 'user-1')).rejects.toThrow(SeatNotFoundError);
    });

    it('activates a pending invite', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'active' });
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');

      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.activeSeats).toBe(1);
    });
  });

  describe('updateMemberRole', () => {
    it('throws SeatNotFoundError for non-active member', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'active' });
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');

      await expect(service.updateMemberRole('tenant-1', 'user-1', 'admin')).rejects.toThrow(
        SeatNotFoundError,
      );
    });

    it('updates role for active member', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'active' });
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');
      await service.updateMemberRole('tenant-1', 'user-1', 'admin');

      const summary = await service.getTeamSummary('tenant-1');
      const member = summary.members.find((m) => m.userId === 'user-1');
      expect(member?.role).toBe('admin');
    });
  });

  describe('removeMember', () => {
    it('throws SeatNotFoundError for non-existent member', async () => {
      await expect(service.removeMember('tenant-1', 'user-1')).rejects.toThrow(SeatNotFoundError);
    });

    it('removes an active member', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'active' });
      await service.inviteMember('tenant-1', 'user-1', 'member', 'owner-1');
      await service.acceptInvite('tenant-1', 'user-1');
      await service.removeMember('tenant-1', 'user-1');

      const summary = await service.getTeamSummary('tenant-1');
      expect(summary.activeSeats).toBe(0);
    });
  });
});
