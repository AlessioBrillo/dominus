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
  InvitationInvalidError,
  InvitationEmailMismatchError,
} from '../team-service.js';
import { TeamInvitationsRepository } from '../../db/repositories/team-invitations-repository.js';
import type { Mailer } from '../../providers/email/mailer.js';
import type { SubscriptionPlan } from '../../types/subscription.js';

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

  describe('pending invitations hold a seat', () => {
    it('rejects invites beyond the plan limit even when none were accepted yet', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'pro', status: 'active' });
      await service.inviteMember('tenant-1', 'u1', 'member', 'owner');
      await service.inviteMember('tenant-1', 'u2', 'member', 'owner');
      await service.inviteMember('tenant-1', 'u3', 'member', 'owner');

      await expect(service.inviteMember('tenant-1', 'u4', 'member', 'owner')).rejects.toThrow(
        TeamSeatLimitError,
      );
    });

    it('allows re-inviting a user whose invitation is already pending', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'pro', status: 'active' });
      await service.inviteMember('tenant-1', 'u1', 'member', 'owner');
      await service.inviteMember('tenant-1', 'u2', 'member', 'owner');
      await service.inviteMember('tenant-1', 'u3', 'member', 'owner');

      await expect(
        service.inviteMember('tenant-1', 'u3', 'admin', 'owner'),
      ).resolves.toBeUndefined();
    });

    it('refuses to activate an invite when active seats already fill the plan', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'pro', status: 'active' });
      await service.inviteMember('tenant-1', 'u1', 'member', 'owner');
      await service.acceptInvite('tenant-1', 'u1');
      await service.inviteMember('tenant-1', 'u2', 'member', 'owner');
      await service.acceptInvite('tenant-1', 'u2');
      await service.inviteMember('tenant-1', 'u3', 'member', 'owner');
      await service.acceptInvite('tenant-1', 'u3');
      // Plan downgraded after the invite was issued.
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'free', status: 'active' });
      await seatsRepo.invite('tenant-1', 'late', 'member', 'owner');

      await expect(service.acceptInvite('tenant-1', 'late')).rejects.toThrow(TeamSeatLimitError);
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

  describe('plan override (ADR-0057)', () => {
    it('raises seat limits when an operator override is wired', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'free', status: 'active' });
      const overridden = new TeamService(seatsRepo, subRepo, {
        planOverrideProvider: async (tenantId: string): Promise<SubscriptionPlan | null> =>
          tenantId === 'tenant-1' ? 'enterprise' : null,
      });

      for (let i = 1; i <= 5; i++) {
        await overridden.inviteMember('tenant-1', `user-${i}`, 'member', 'owner-1');
      }
      const summary = await overridden.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('enterprise');
      expect(summary.seatLimit).toBeNull();
      expect(summary.pendingSeats).toBe(5);
    });

    it('survives a lapsed subscription (deliberate manual grant)', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'team', status: 'past_due' });
      const overridden = new TeamService(seatsRepo, subRepo, {
        planOverrideProvider: async (tenantId: string): Promise<SubscriptionPlan | null> =>
          tenantId === 'tenant-1' ? 'team' : null,
      });

      expect(await overridden.canAddSeat('tenant-1')).toBe(true);
      const summary = await overridden.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('team');
      expect(summary.seatLimit).toBe(10);
    });

    it('leaves other tenants on subscription-driven limits', async () => {
      await subRepo.upsert({ tenantId: 'tenant-1', plan: 'free', status: 'active' });
      const overridden = new TeamService(seatsRepo, subRepo, {
        planOverrideProvider: async (tenantId: string): Promise<SubscriptionPlan | null> =>
          tenantId === 'tenant-2' ? 'enterprise' : null,
      });

      const summary = await overridden.getTeamSummary('tenant-1');
      expect(summary.plan).toBe('free');
      expect(summary.seatLimit).toBe(1);
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

describe('TeamService email invitations', () => {
  let db: SqliteProvider;
  let seatsRepo: TeamSeatsRepository;
  let subRepo: SubscriptionRepository;
  let invRepo: TeamInvitationsRepository;
  const sent: { to: string | string[]; text: string }[] = [];
  let mailerConfigured = true;
  let mailerFails = false;

  const mailer: Mailer = {
    get configured() {
      return mailerConfigured;
    },
    async send(msg) {
      if (mailerFails) throw new Error('smtp down');
      sent.push({ to: msg.to, text: msg.text });
    },
  };

  const build = (): TeamService =>
    new TeamService(seatsRepo, subRepo, {
      invitations: { repo: invRepo, mailer, appUrl: 'https://app.example.com/', ttlHours: 1 },
    });

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    seatsRepo = new TeamSeatsRepository(db);
    subRepo = new SubscriptionRepository(db);
    invRepo = new TeamInvitationsRepository(db);
    sent.length = 0;
    mailerConfigured = true;
    mailerFails = false;
    await subRepo.upsert({ tenantId: 't1', plan: 'pro', status: 'active' }); // 3 seats
    await seatsRepo.invite('t1', 'owner', 'admin', 'owner');
    await seatsRepo.acceptInvite('t1', 'owner');
  });

  afterEach(async () => {
    await db.close();
  });

  const tokenOf = (link: string): string => link.split('/invite/')[1]!;

  it('returns a one-time link, stores only the hash and emails the invitee', async () => {
    const { invitation, link, emailed } = await build().createInvitation(
      't1',
      '  New.User@Example.com ',
      'member',
      'owner',
    );

    expect(link.startsWith('https://app.example.com/invite/')).toBe(true);
    expect(invitation.email).toBe('new.user@example.com');
    expect(emailed).toBe(true);
    expect(sent[0]?.to).toBe('new.user@example.com');
    expect(sent[0]?.text).toContain(link);

    const stored = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM team_invitations',
    );
    expect(stored[0]?.token_hash).not.toContain(tokenOf(link));
    expect(stored[0]?.token_hash).toHaveLength(64);
  });

  it('does not email a relative link when PUBLIC_APP_URL is unset', async () => {
    const service = new TeamService(seatsRepo, subRepo, {
      invitations: { repo: invRepo, mailer, ttlHours: 1 }, // no appUrl
    });
    const { link, emailed } = await service.createInvitation(
      't1',
      'a@example.com',
      'member',
      'owner',
    );
    expect(emailed).toBe(false);
    expect(sent).toHaveLength(0);
    expect(link.startsWith('/invite/')).toBe(true);
  });

  it('still returns the link when email is not configured or fails', async () => {
    mailerConfigured = false;
    const off = await build().createInvitation('t1', 'a@example.com', 'member', 'owner');
    expect(off.emailed).toBe(false);
    expect(off.link).toContain('/invite/');

    mailerConfigured = true;
    mailerFails = true;
    const failed = await build().createInvitation('t1', 'b@example.com', 'member', 'owner');
    expect(failed.emailed).toBe(false);
    expect(await invRepo.countPending('t1')).toBe(2);
  });

  it('counts outstanding invitations against the plan seat limit', async () => {
    const service = build();
    await service.createInvitation('t1', 'a@example.com', 'member', 'owner');
    await service.createInvitation('t1', 'b@example.com', 'member', 'owner');
    // owner + 2 invitations = 3 seats on the pro plan

    await expect(
      service.createInvitation('t1', 'c@example.com', 'member', 'owner'),
    ).rejects.toThrow(TeamSeatLimitError);
    expect(await service.canAddSeat('t1')).toBe(false);
  });

  it('activates a seat on accept and rejects a second use of the same link', async () => {
    const service = build();
    const { link } = await service.createInvitation('t1', 'a@example.com', 'admin', 'owner');

    const joined = await service.acceptInvitation(tokenOf(link), 'auth0|new', 'a@example.com');
    expect(joined).toEqual({ tenantId: 't1', role: 'admin' });
    expect((await seatsRepo.findByTenantAndUser('t1', 'auth0|new'))?.status).toBe('active');

    await expect(
      service.acceptInvitation(tokenOf(link), 'auth0|other', 'a@example.com'),
    ).rejects.toThrow(InvitationInvalidError);
  });

  describe('email binding', () => {
    it('refuses a different verified email and leaves the invitation usable', async () => {
      const service = build();
      const { link } = await service.createInvitation('t1', 'bob@example.com', 'admin', 'owner');

      await expect(
        service.acceptInvitation(tokenOf(link), 'auth0|mallory', 'mallory@example.com'),
      ).rejects.toThrow(InvitationEmailMismatchError);
      expect(await seatsRepo.findByTenantAndUser('t1', 'auth0|mallory')).toBeUndefined();

      // The wrong person could not burn the link: the real invitee can still join.
      await expect(
        service.acceptInvitation(tokenOf(link), 'auth0|bob', 'BOB@Example.com'),
      ).resolves.toEqual({ tenantId: 't1', role: 'admin' });
    });

    it('refuses a session with no verified email', async () => {
      const service = build();
      const { link } = await service.createInvitation('t1', 'bob@example.com', 'member', 'owner');

      const err = await service
        .acceptInvitation(tokenOf(link), 'auth0|bob')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvitationEmailMismatchError);
      expect((err as InvitationEmailMismatchError).reason).toBe('no-verified-email');
    });
  });

  it('rejects unknown, revoked and expired tokens alike', async () => {
    const service = build();
    await expect(service.acceptInvitation('nope', 'u', 'a@example.com')).rejects.toThrow(
      InvitationInvalidError,
    );

    const { invitation, link } = await service.createInvitation(
      't1',
      'a@example.com',
      'member',
      'owner',
    );
    expect(await service.revokeInvitation('t1', invitation.id)).toBe(true);
    await expect(service.acceptInvitation(tokenOf(link), 'u', 'a@example.com')).rejects.toThrow(
      InvitationInvalidError,
    );

    const second = await service.createInvitation('t1', 'b@example.com', 'member', 'owner');
    await db.exec("UPDATE team_invitations SET expires_at = '2000-01-01 00:00:00' WHERE id = ?", [
      second.invitation.id,
    ]);
    await expect(
      service.acceptInvitation(tokenOf(second.link), 'u', 'b@example.com'),
    ).rejects.toThrow(InvitationInvalidError);
  });

  it('cannot revoke another tenant invitation', async () => {
    const service = build();
    const { invitation } = await service.createInvitation('t1', 'a@example.com', 'member', 'owner');
    expect(await service.revokeInvitation('other-tenant', invitation.id)).toBe(false);
    expect(await invRepo.countPending('t1')).toBe(1);
  });

  it('releases the claim when the plan no longer has room, so the link can be retried', async () => {
    const service = build();
    const { link } = await service.createInvitation('t1', 'a@example.com', 'member', 'owner');
    // Plan lapses after the invite was issued: free = 1 seat, already taken by the owner.
    await subRepo.upsert({ tenantId: 't1', plan: 'free', status: 'active' });

    await expect(service.acceptInvitation(tokenOf(link), 'u2', 'a@example.com')).rejects.toThrow(
      TeamSeatLimitError,
    );

    await subRepo.upsert({ tenantId: 't1', plan: 'pro', status: 'active' });
    await expect(
      service.acceptInvitation(tokenOf(link), 'u2', 'a@example.com'),
    ).resolves.toMatchObject({
      tenantId: 't1',
    });
  });

  it('lists pending invitations in the team summary without token material', async () => {
    const service = build();
    await service.createInvitation('t1', 'a@example.com', 'member', 'owner');
    const summary = await service.getTeamSummary('t1');
    expect(summary.invitations).toHaveLength(1);
    expect(JSON.stringify(summary.invitations)).not.toMatch(/token/i);
  });
});
