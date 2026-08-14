// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { UsageRepository } from '../../db/repositories/usage-repository.js';
import { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import { AdminRepository } from '../../db/repositories/admin-repository.js';
import { UsageMeterService } from '../usage-meter-service.js';
import { PipelineUsageEnforcer, estimateCandidateCount } from '../pipeline-usage-enforcer.js';
import { runWithTenant } from '../../utils/tenant-context.js';
import { TenantSuspendedError, UsageLimitExceededError } from '../../types/errors.js';
import type { CandidateGenerationInput } from '../../pipeline/stages/candidate-generation-stage.js';

const PERIOD = UsageMeterService.periodStart(new Date().toISOString());

describe('estimateCandidateCount', () => {
  it('sums every explicit input list', () => {
    const input: CandidateGenerationInput = {
      keywords: ['a', 'b'],
      brandableNames: ['x.com'],
      closeoutDomains: ['y.com', 'z.com'],
      closeoutEntries: [{ domain: 'w.com', domainAge: 5, backlinks: 1, waybackSnapshots: 2 }],
      domains: ['v.com'],
    };
    expect(estimateCandidateCount(input)).toBe(7);
  });

  it('counts only the lists that are present', () => {
    expect(estimateCandidateCount({ keywords: ['a', 'b', 'c'] })).toBe(3);
    expect(estimateCandidateCount({ domains: ['a.com'] })).toBe(1);
    expect(estimateCandidateCount({})).toBe(1);
    expect(estimateCandidateCount(undefined as unknown as CandidateGenerationInput)).toBe(1);
  });
});

describe('PipelineUsageEnforcer', () => {
  let db: SqliteProvider;
  let usageRepo: UsageRepository;
  let subRepo: SubscriptionRepository;
  let usageService: UsageMeterService;
  let adminRepo: AdminRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    usageRepo = new UsageRepository(db);
    subRepo = new SubscriptionRepository(db);
    adminRepo = new AdminRepository(db);
    usageService = new UsageMeterService(usageRepo, subRepo);
  });

  afterEach(async () => {
    await db.close();
  });

  describe('when enforcement is disabled (community default)', () => {
    it('never records and never throws', async () => {
      const enforcer = new PipelineUsageEnforcer(usageService, false);
      await expect(
        enforcer.checkAndRecordCandidates({ keywords: ['a', 'b'] }),
      ).resolves.not.toThrow();
      await expect(enforcer.checkAndRecordTracked(1)).resolves.not.toThrow();

      const usage = await usageRepo.getUsageForPeriod('default', 'candidates_scored', PERIOD);
      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(usage).toBe(0);
      expect(tracked).toBe(0);
    });
  });

  describe('when enforcement is enabled', () => {
    it('records the estimated candidate count against the tenant plan', async () => {
      await subRepo.ensureDefault('default');
      const enforcer = new PipelineUsageEnforcer(usageService, true);

      await enforcer.checkAndRecordCandidates({
        keywords: ['a', 'b'],
        closeoutDomains: ['x.com'],
      });

      const usage = await usageRepo.getUsageForPeriod('default', 'candidates_scored', PERIOD);
      expect(usage).toBe(3);
    });

    it('records domains_tracked units', async () => {
      await subRepo.ensureDefault('default');
      const enforcer = new PipelineUsageEnforcer(usageService, true);

      await enforcer.checkAndRecordTracked(1);
      await enforcer.checkAndRecordTracked(1);

      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(2);
    });

    it('resolves the tenant from the async context when present', async () => {
      await subRepo.ensureDefault('tenant-x');
      const enforcer = new PipelineUsageEnforcer(usageService, true);

      await runWithTenant('tenant-x', () => enforcer.checkAndRecordCandidates({ keywords: ['a'] }));

      const usage = await usageRepo.getUsageForPeriod('tenant-x', 'candidates_scored', PERIOD);
      expect(usage).toBe(1);
    });

    it('throws UsageLimitExceededError when the free plan limit is exhausted', async () => {
      await subRepo.ensureDefault('default');
      const enforcer = new PipelineUsageEnforcer(usageService, true);

      await enforcer.checkAndRecordCandidates({ keywords: Array(50).fill('k') });
      await expect(
        enforcer.checkAndRecordCandidates({ keywords: ['one-more'] }),
      ).rejects.toBeInstanceOf(UsageLimitExceededError);
    });

    it('refunds domains_tracked units back to the allowance', async () => {
      await subRepo.ensureDefault('default');
      const enforcer = new PipelineUsageEnforcer(usageService, true);

      await enforcer.checkAndRecordTracked(2);
      await enforcer.refundTracked(1);

      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(1);
    });

    it('refund floors at zero — a refund without consumed usage is a no-op', async () => {
      await subRepo.ensureDefault('default');
      const enforcer = new PipelineUsageEnforcer(usageService, true);

      await enforcer.refundTracked(1);
      await enforcer.checkAndRecordTracked(1);
      await enforcer.refundTracked(5);

      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(0);
    });

    it('refund is a no-op when enforcement is disabled', async () => {
      const enforcer = new PipelineUsageEnforcer(usageService, false);

      await enforcer.refundTracked(1);

      const tracked = await usageRepo.getUsageForPeriod('default', 'domains_tracked', PERIOD);
      expect(tracked).toBe(0);
    });
  });

  describe('suspension gate (ADR-0057)', () => {
    it('throws TenantSuspendedError for a suspended tenant', async () => {
      await subRepo.ensureDefault('tenant-x');
      await adminRepo.setSuspended('tenant-x', 'abuse', new Date().toISOString());
      const enforcer = new PipelineUsageEnforcer(usageService, true, adminRepo);

      await expect(
        runWithTenant('tenant-x', () => enforcer.checkAndRecordCandidates({ keywords: ['a'] })),
      ).rejects.toBeInstanceOf(TenantSuspendedError);
    });

    it('blocks tracked recording for a suspended tenant too', async () => {
      await subRepo.ensureDefault('tenant-x');
      await adminRepo.setSuspended('tenant-x', 'abuse', new Date().toISOString());
      const enforcer = new PipelineUsageEnforcer(usageService, true, adminRepo);

      await expect(
        runWithTenant('tenant-x', () => enforcer.checkAndRecordTracked(1)),
      ).rejects.toBeInstanceOf(TenantSuspendedError);
    });

    it('does not record usage when the suspension gate fires', async () => {
      await subRepo.ensureDefault('tenant-x');
      await adminRepo.setSuspended('tenant-x', 'abuse', new Date().toISOString());
      const enforcer = new PipelineUsageEnforcer(usageService, true, adminRepo);

      await runWithTenant('tenant-x', () =>
        enforcer.checkAndRecordCandidates({ keywords: ['a'] }).catch(() => null),
      );

      const usage = await usageRepo.getUsageForPeriod('tenant-x', 'candidates_scored', PERIOD);
      expect(usage).toBe(0);
    });

    it('allows a non-suspended tenant through', async () => {
      await subRepo.ensureDefault('tenant-x');
      const enforcer = new PipelineUsageEnforcer(usageService, true, adminRepo);

      await runWithTenant('tenant-x', () => enforcer.checkAndRecordCandidates({ keywords: ['a'] }));

      const usage = await usageRepo.getUsageForPeriod('tenant-x', 'candidates_scored', PERIOD);
      expect(usage).toBe(1);
    });

    it('allows a cleared suspension through', async () => {
      await subRepo.ensureDefault('tenant-x');
      await adminRepo.setSuspended('tenant-x', 'abuse', new Date().toISOString());
      await adminRepo.clearSuspended('tenant-x', new Date().toISOString());
      const enforcer = new PipelineUsageEnforcer(usageService, true, adminRepo);

      await runWithTenant('tenant-x', () => enforcer.checkAndRecordCandidates({ keywords: ['a'] }));

      const usage = await usageRepo.getUsageForPeriod('tenant-x', 'candidates_scored', PERIOD);
      expect(usage).toBe(1);
    });

    it('is a no-op when no admin repo is wired (community edition)', async () => {
      await subRepo.ensureDefault('tenant-x');
      await adminRepo.setSuspended('tenant-x', 'abuse', new Date().toISOString());
      const enforcer = new PipelineUsageEnforcer(usageService, true);

      await runWithTenant('tenant-x', () => enforcer.checkAndRecordCandidates({ keywords: ['a'] }));

      const usage = await usageRepo.getUsageForPeriod('tenant-x', 'candidates_scored', PERIOD);
      expect(usage).toBe(1);
    });
  });
});
