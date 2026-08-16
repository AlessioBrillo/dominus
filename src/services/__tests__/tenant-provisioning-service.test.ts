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
    ...(overrides.teamSeatsRepo as object | undefined),
  } as unknown as TeamSeatsRepository;
  const keyManager = {
    generate: vi.fn().mockResolvedValue({
      id: 1,
      fullKey: 'deadbeef',
      prefix: 'deadbeef',
      name: 'owner',
    }),
    ...(overrides.keyManager as object | undefined),
  } as unknown as KeyManager;
  return { subscriptionRepo, teamSeatsRepo, keyManager };
}

describe('TenantProvisioningService', () => {
  it('provisions a tenant with free plan, active owner seat, and admin key', async () => {
    const { subscriptionRepo, teamSeatsRepo, keyManager } = makeDeps();
    const service = new TenantProvisioningService(subscriptionRepo, teamSeatsRepo, keyManager);

    const result = await service.provisionTenant({ name: 'Alessio', email: 'a@example.com' });

    expect(result.tenantId).toMatch(/^tenant-[0-9a-f]{16}$/);
    expect(result.apiKey.fullKey).toBe('deadbeef');
    expect(subscriptionRepo.ensureDefault).toHaveBeenCalledWith(result.tenantId);
    expect(teamSeatsRepo.invite).toHaveBeenCalledWith(
      result.tenantId,
      'a@example.com',
      'admin',
      'a@example.com',
    );
    expect(teamSeatsRepo.acceptInvite).toHaveBeenCalledWith(result.tenantId, 'a@example.com');
    expect(keyManager.generate).toHaveBeenCalledWith({
      tenantId: result.tenantId,
      name: 'Alessio',
      role: 'admin',
    });
  });

  it('generates a synthetic owner id when no email is provided', async () => {
    const { teamSeatsRepo } = makeDeps();
    const service = new TenantProvisioningService(
      makeDeps().subscriptionRepo,
      teamSeatsRepo,
      makeDeps().keyManager,
    );

    await service.provisionTenant({ name: 'Anonymous' });

    const inviteCall = (teamSeatsRepo.invite as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(inviteCall[1])).toMatch(/^tenant-[0-9a-f]{16}-owner$/);
  });
});
