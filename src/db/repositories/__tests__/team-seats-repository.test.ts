// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { TeamSeatsRepository, type TeamRole } from '../team-seats-repository.js';

describe('TeamSeatsRepository', () => {
  let db: SqliteProvider;
  let repo: TeamSeatsRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new TeamSeatsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('starts with no seats', async () => {
    const seats = await repo.findByTenantId('tenant-1');
    expect(seats).toHaveLength(0);
    expect(await repo.countActiveSeats('tenant-1')).toBe(0);
  });

  it('invites a member and returns pending status', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');

    const seat = await repo.findByTenantAndUser('tenant-1', 'user-1');
    expect(seat).toMatchObject({
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'member' as TeamRole,
      invitedBy: 'owner-1',
      status: 'pending',
    });
    expect(seat?.joinedAt).toBeNull();
  });

  it('accepts an invite and sets active status with joined_at', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.acceptInvite('tenant-1', 'user-1');

    const seat = await repo.findByTenantAndUser('tenant-1', 'user-1');
    expect(seat?.status).toBe('active');
    expect(seat?.joinedAt).toBeTruthy();
  });

  it('counts only active seats', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.invite('tenant-1', 'user-2', 'admin', 'owner-1');
    await repo.acceptInvite('tenant-1', 'user-1');

    expect(await repo.countActiveSeats('tenant-1')).toBe(1);

    await repo.acceptInvite('tenant-1', 'user-2');
    expect(await repo.countActiveSeats('tenant-1')).toBe(2);
  });

  it('finds only active seats', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.invite('tenant-1', 'user-2', 'admin', 'owner-1');
    await repo.acceptInvite('tenant-1', 'user-1');

    const active = await repo.findActiveByTenantId('tenant-1');
    expect(active).toHaveLength(1);
    expect(active[0]?.userId).toBe('user-1');
  });

  it('updates role', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.acceptInvite('tenant-1', 'user-1');
    await repo.updateRole('tenant-1', 'user-1', 'admin');

    const seat = await repo.findByTenantAndUser('tenant-1', 'user-1');
    expect(seat?.role).toBe('admin');
  });

  it('removes a member (soft delete)', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.acceptInvite('tenant-1', 'user-1');
    await repo.remove('tenant-1', 'user-1');

    const seat = await repo.findByTenantAndUser('tenant-1', 'user-1');
    expect(seat?.status).toBe('removed');
    expect(await repo.countActiveSeats('tenant-1')).toBe(0);
  });

  it('hard removes a member', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.hardRemove('tenant-1', 'user-1');

    const seat = await repo.findByTenantAndUser('tenant-1', 'user-1');
    expect(seat).toBeUndefined();
  });

  it('is scoped by tenant', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.invite('tenant-2', 'user-2', 'member', 'owner-2');

    const seats1 = await repo.findByTenantId('tenant-1');
    const seats2 = await repo.findByTenantId('tenant-2');

    expect(seats1).toHaveLength(1);
    expect(seats2).toHaveLength(1);
    expect(seats1[0]?.userId).toBe('user-1');
    expect(seats2[0]?.userId).toBe('user-2');
  });

  it('re-invite updates existing seat to pending', async () => {
    await repo.invite('tenant-1', 'user-1', 'member', 'owner-1');
    await repo.acceptInvite('tenant-1', 'user-1');
    await repo.remove('tenant-1', 'user-1');
    await repo.invite('tenant-1', 'user-1', 'admin', 'owner-1');

    const seat = await repo.findByTenantAndUser('tenant-1', 'user-1');
    expect(seat?.status).toBe('pending');
    expect(seat?.role).toBe('admin');
  });
});
