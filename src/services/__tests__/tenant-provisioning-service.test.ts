// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { TenantProvisioningService } from '../tenant-provisioning-service.js';
import type { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import type { TeamSeatsRepository } from '../../db/repositories/team-seats-repository.js';
import type { KeyManager } from '../../providers/auth/auth-provider.js';

function makeDeps(overrides: Partial<Record<string, unknown>> = {}): {
  subscriptionRepo: SubscriptionRepository;
  teamSeatsRepo: TeamSeatsRepository;
  keyManager: KeyManager;
} {
  const subscriptionRepo = {
    ensureDefault: vi.fn().mockResolvedValue({ plan: 'free', status: 'active' }),
    ...(overrides.subscriptionRepo as object | undefined),
  } as unknown as SubscriptionRepository;
  const teamSeatsRepo = {
    invite: vi.fn().mockResolvedValue(undefined),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    findByTenantAndUser: vi.fn().mockResolvedValue(undefined),
    ...(overrides.teamSeatsRepo as object | undefined),
  } as unknown as TeamSeatsRepository;
  const keyManager = {
    generate: vi.fn().mockResolvedValue({
      id: 1,
      fullKey: 'deadbeef',
      prefix: 'deadbeef',
      name: 'owner',
    }),
    revokeAll: vi.fn().mockResolvedValue(0),
    ...(overrides.keyManager as object | undefined),
  } as unknown as KeyManager;
  return { subscriptionRepo, teamSeatsRepo, keyManager };
}

describe('TenantProvisioningService', () => {
  it('provisions a tenant with a free plan and a PENDING owner seat, and no key', async () => {
    const { subscriptionRepo, teamSeatsRepo, keyManager } = makeDeps();
    const service = new TenantProvisioningService(subscriptionRepo, teamSeatsRepo, keyManager);

    const result = await service.provisionTenant({ name: 'Alessio', email: 'a@example.com' });

    expect(result.tenantId).toMatch(/^tenant-[0-9a-f]{16}$/);
    expect(subscriptionRepo.ensureDefault).toHaveBeenCalledWith(result.tenantId);
    expect(teamSeatsRepo.invite).toHaveBeenCalledWith(
      result.tenantId,
      'a@example.com',
      'admin',
      'a@example.com',
    );
    // The seat stays pending and NO key is issued: the address was never
    // proven, and a key handed to whoever typed an address is a key handed
    // to whoever typed it first.
    expect(teamSeatsRepo.acceptInvite).not.toHaveBeenCalled();
    expect(keyManager.generate).not.toHaveBeenCalled();
  });

  it('normalizes the email of the owner', async () => {
    const { teamSeatsRepo } = makeDeps();
    const service = new TenantProvisioningService(
      makeDeps().subscriptionRepo,
      teamSeatsRepo,
      makeDeps().keyManager,
    );

    await service.provisionTenant({ name: 'Alessio', email: '  Alessio@Example.COM ' });

    const inviteCall = (teamSeatsRepo.invite as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(inviteCall[1])).toBe('alessio@example.com');
  });

  it('activates the owner seat and issues the key on demand', async () => {
    const { teamSeatsRepo, keyManager } = makeDeps();
    const service = new TenantProvisioningService(
      makeDeps().subscriptionRepo,
      teamSeatsRepo,
      keyManager,
    );

    const key = await service.activateOwner({
      tenantId: 'tenant-abc',
      email: 'a@example.com',
      name: 'Alessio',
    });

    expect(key.fullKey).toBe('deadbeef');
    expect(teamSeatsRepo.acceptInvite).toHaveBeenCalledWith('tenant-abc', 'a@example.com');
    expect(keyManager.generate).toHaveBeenCalledWith({
      tenantId: 'tenant-abc',
      name: 'Alessio',
      role: 'admin',
    });
  });
});
