// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { TeamSeatsRepository } from '../../db/repositories/team-seats-repository.js';
import { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import { TenantProvisioningService } from '../tenant-provisioning-service.js';
import { IdentityTenantResolver, sessionRoleFor } from '../identity-tenant-resolver.js';

describe('IdentityTenantResolver', () => {
  let db: SqliteProvider;
  let seats: TeamSeatsRepository;
  let subs: SubscriptionRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    seats = new TeamSeatsRepository(db);
    subs = new SubscriptionRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  const resolver = (autoProvision = true): IdentityTenantResolver =>
    new IdentityTenantResolver(
      seats,
      new TenantProvisioningService(subs, seats, undefined),
      autoProvision,
    );

  const join = async (
    tenantId: string,
    userId: string,
    role: 'admin' | 'member',
  ): Promise<void> => {
    await seats.invite(tenantId, userId, role, 'owner');
    await seats.acceptInvite(tenantId, userId);
  };

  it('maps seat roles to session roles (owner/admin manage, member does not)', () => {
    expect(sessionRoleFor('owner')).toBe('admin');
    expect(sessionRoleFor('admin')).toBe('admin');
    expect(sessionRoleFor('member')).toBe('member');
  });

  it('uses the active seat, ignoring a tenant/role the IdP claims', async () => {
    await join('team-a', 'auth0|u1', 'member');
    const r = await resolver().resolve({
      sub: 'auth0|u1',
      orgId: 'forged-org',
      claimedRole: 'admin',
    });
    expect(r).toEqual({ tenantId: 'team-a', role: 'member' });
  });

  it('prefers the most recently joined team', async () => {
    await join('personal', 'auth0|u1', 'admin');
    await db.exec("UPDATE team_seats SET joined_at = '2020-01-01 00:00:00'");
    await join('joined-later', 'auth0|u1', 'member');
    expect((await resolver().resolve({ sub: 'auth0|u1' })).tenantId).toBe('joined-later');
  });

  it('ignores pending and removed seats', async () => {
    await seats.invite('team-p', 'auth0|u1', 'admin', 'owner'); // pending
    await join('team-r', 'auth0|u1', 'admin');
    await seats.remove('team-r', 'auth0|u1');
    const r = await resolver(false).resolve({ sub: 'auth0|u1' });
    expect(r.tenantId).toBeUndefined();
  });

  it('falls back to the IdP organization when there is no seat', async () => {
    const r = await resolver().resolve({ sub: 'auth0|u2', orgId: 'org-9', claimedRole: 'member' });
    expect(r).toEqual({ tenantId: 'org-9', role: 'member' });
  });

  it('provisions a tenant on first sign-in and reuses it afterwards', async () => {
    const first = await resolver().resolve({ sub: 'auth0|new' });
    expect(first.tenantId).toMatch(/^tenant-/);
    expect(first.role).toBe('admin');
    expect((await seats.findActiveByUserId('auth0|new'))[0]?.tenantId).toBe(first.tenantId);
    expect((await subs.findByTenantId(first.tenantId!))?.plan).toBe('free');

    const second = await resolver().resolve({ sub: 'auth0|new' });
    expect(second.tenantId).toBe(first.tenantId);
  });

  it('concurrent first sign-ins converge on one tenant', async () => {
    const r = resolver();
    const results = await Promise.all([
      r.resolve({ sub: 'auth0|race' }),
      r.resolve({ sub: 'auth0|race' }),
      r.resolve({ sub: 'auth0|race' }),
    ]);
    expect(new Set(results.map((x) => x.tenantId)).size).toBe(1);
    expect(await seats.findActiveByUserId('auth0|race')).toHaveLength(1);
  });

  it('does not provision when auto-provisioning is off', async () => {
    const r = await resolver(false).resolve({ sub: 'auth0|new', claimedRole: 'admin' });
    expect(r).toEqual({ tenantId: undefined, role: 'admin' });
    expect(await seats.findActiveByUserId('auth0|new')).toHaveLength(0);
  });

  describe('validateSession (live check of an 8-hour session)', () => {
    it('passes an active seat and returns the current role', async () => {
      await join('team-a', 'auth0|u1', 'admin');
      expect(await resolver().validateSession({ sub: 'auth0|u1', tenantId: 'team-a' })).toEqual({
        role: 'admin',
      });
    });

    it('applies a demotion immediately', async () => {
      await join('team-a', 'auth0|u1', 'admin');
      await seats.updateRole('team-a', 'auth0|u1', 'member');
      expect(await resolver().validateSession({ sub: 'auth0|u1', tenantId: 'team-a' })).toEqual({
        role: 'member',
      });
    });

    it('rejects a removed member', async () => {
      await join('team-a', 'auth0|u1', 'member');
      await seats.remove('team-a', 'auth0|u1');
      expect(await resolver().validateSession({ sub: 'auth0|u1', tenantId: 'team-a' })).toBeNull();
    });

    it('rejects a seat that is not active yet', async () => {
      await seats.invite('team-a', 'auth0|u1', 'member', 'owner');
      expect(await resolver().validateSession({ sub: 'auth0|u1', tenantId: 'team-a' })).toBeNull();
    });

    it('trusts sessions that have no seat (IdP organization claim) or no tenant', async () => {
      expect(await resolver().validateSession({ sub: 'auth0|org', tenantId: 'org-9' })).toEqual({});
      expect(await resolver().validateSession({ sub: 'auth0|x' })).toEqual({});
    });
  });
});
