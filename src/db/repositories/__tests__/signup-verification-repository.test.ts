// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { SignupVerificationRepository } from '../signup-verification-repository.js';
import { TeamSeatsRepository } from '../team-seats-repository.js';

/**
 * The prune of the workspaces that were never verified.
 *
 * A pending, unverified seat is ALSO the shape of an invitation to a
 * colleague. The deletion must therefore be confined to workspaces where
 * nobody ever proved an address and nobody ever held a key: an established
 * workspace with an invitation nobody accepted must survive, with its
 * subscription.
 */
describe('SignupVerificationRepository.deleteUnverifiedWorkspaces', () => {
  let db: SqliteProvider;
  let repo: SignupVerificationRepository;
  let seats: TeamSeatsRepository;

  const OLD = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const CUTOFF = new Date(Date.now() - 7 * 86_400_000).toISOString();

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new SignupVerificationRepository(db);
    seats = new TeamSeatsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function ageSeat(tenantId: string, userId: string, at = OLD): Promise<void> {
    await db.exec('UPDATE team_seats SET invited_at = ? WHERE tenant_id = ? AND user_id = ?', [
      at,
      tenantId,
      userId,
    ]);
  }

  async function subscribe(tenantId: string): Promise<void> {
    await db.exec(
      "INSERT INTO tenant_subscriptions (tenant_id, plan, status) VALUES (?, 'free', 'active')",
      [tenantId],
    );
  }

  async function count(table: string, tenantId: string): Promise<number> {
    const row = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${table} WHERE tenant_id = ?`,
      [tenantId],
    );
    return Number(row?.count ?? 0);
  }

  it('removes an inert workspace together with its token and subscription', async () => {
    await seats.invite('tenant-inert', 'owner@example.com', 'admin', 'owner@example.com');
    await ageSeat('tenant-inert', 'owner@example.com');
    await subscribe('tenant-inert');
    await repo.create({
      tenantId: 'tenant-inert',
      email: 'owner@example.com',
      tokenHash: 'hash-inert',
      purpose: 'signup',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const removed = await repo.deleteUnverifiedWorkspaces(CUTOFF);

    expect(removed).toBe(1);
    expect(await count('team_seats', 'tenant-inert')).toBe(0);
    expect(await count('tenant_subscriptions', 'tenant-inert')).toBe(0);
    expect(await count('signup_verifications', 'tenant-inert')).toBe(0);
  });

  it('keeps an established workspace whose invitation was never accepted', async () => {
    // The owner proved the address: the workspace is real and subscribed.
    await seats.invite('tenant-live', 'owner@example.com', 'admin', 'owner@example.com');
    await seats.acceptInvite('tenant-live', 'owner@example.com');
    await seats.markEmailVerified('tenant-live', 'owner@example.com');
    await subscribe('tenant-live');
    // The colleague never accepted, and the invitation is older than the
    // retention window.
    await seats.invite('tenant-live', 'colleague@example.com', 'member', 'owner@example.com');
    await ageSeat('tenant-live', 'owner@example.com');
    await ageSeat('tenant-live', 'colleague@example.com');

    const removed = await repo.deleteUnverifiedWorkspaces(CUTOFF);

    expect(removed).toBe(0);
    expect(await count('team_seats', 'tenant-live')).toBe(2);
    expect(await count('tenant_subscriptions', 'tenant-live')).toBe(1);
  });

  it('keeps a workspace whose owner holds a key (the optional verification mode)', async () => {
    // SIGNUP_EMAIL_VERIFICATION=optional: the seat is active but the address
    // was never proven, and the workspace is in use.
    await seats.invite('tenant-optional', 'owner@example.com', 'admin', 'owner@example.com');
    await seats.acceptInvite('tenant-optional', 'owner@example.com');
    await subscribe('tenant-optional');
    await ageSeat('tenant-optional', 'owner@example.com');

    const removed = await repo.deleteUnverifiedWorkspaces(CUTOFF);

    expect(removed).toBe(0);
    expect(await count('team_seats', 'tenant-optional')).toBe(1);
    expect(await count('tenant_subscriptions', 'tenant-optional')).toBe(1);
  });

  it('keeps a pending workspace that holds an API key', async () => {
    await seats.invite('tenant-keyed', 'owner@example.com', 'admin', 'owner@example.com');
    await ageSeat('tenant-keyed', 'owner@example.com');
    await db.exec(
      `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, role)
       VALUES (?, 'DOMINUS workspace', 'hash', 'prefix', 'admin')`,
      ['tenant-keyed'],
    );

    const removed = await repo.deleteUnverifiedWorkspaces(CUTOFF);

    expect(removed).toBe(0);
    expect(await count('team_seats', 'tenant-keyed')).toBe(1);
  });

  it('keeps a workspace younger than the retention window', async () => {
    await seats.invite('tenant-fresh', 'owner@example.com', 'admin', 'owner@example.com');

    const removed = await repo.deleteUnverifiedWorkspaces(CUTOFF);

    expect(removed).toBe(0);
    expect(await count('team_seats', 'tenant-fresh')).toBe(1);
  });
});
