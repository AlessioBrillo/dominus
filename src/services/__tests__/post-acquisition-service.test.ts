// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { PostAcquisitionService } from '../post-acquisition-service.js';
import type {
  PostAcquisitionStepExecutor,
  PostAcquisitionStepOutcome,
} from '../post-acquisition-service.js';
import { POST_ACQUISITION_STEPS } from '../../types/automation.js';

/** Deterministic journal row id per step, mirroring POST_ACQUISITION_STEPS order. */
function rowIdForStep(step: string): number {
  return POST_ACQUISITION_STEPS.indexOf(step as never) + 1;
}

function journalRow(input: { domain: string; step: string }): Record<string, unknown> {
  return {
    id: rowIdForStep(input.step),
    domain: input.domain,
    step: input.step,
    status: 'pending',
    attempts: 0,
    source: 'purchase',
    pipelineRunId: null,
    detailJson: null,
    lastError: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRepo(): any {
  return {
    upsert: vi
      .fn()
      .mockImplementation(async (input: { domain: string; step: string }) => journalRow(input)),
    findByDomainAndStep: vi.fn().mockResolvedValue(null),
    findByDomain: vi.fn().mockResolvedValue([]),
    incrementAttempts: vi.fn().mockResolvedValue(undefined),
    markDone: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    resetStep: vi.fn().mockResolvedValue(undefined),
    resetDomain: vi.fn().mockResolvedValue(undefined),
    listRecent: vi.fn().mockResolvedValue([]),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockAuditRepo(): any {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    listRecent: vi.fn().mockResolvedValue([]),
    findByDomain: vi.fn().mockResolvedValue([]),
  };
}

/** Fake tenant settings store; `current` is the stored row state. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockSettingsRepo(current: { enabled: boolean; dryRun: boolean }): any {
  return {
    get: vi.fn().mockResolvedValue({ ...current }),
    set: vi.fn(async (update: Record<string, unknown>) => {
      Object.assign(current, update);
      return { ...current };
    }),
  };
}

/** Fake executor that returns a scripted outcome (or throws). */
function fakeExecutor(
  step: PostAcquisitionStepExecutor['step'],
  behaviour: () => PostAcquisitionStepOutcome,
): PostAcquisitionStepExecutor {
  return { step, execute: vi.fn(async () => behaviour()) };
}

describe('PostAcquisitionService', () => {
  describe('kill switch', () => {
    it('refuses to run when automation is disabled', async () => {
      const repo = mockRepo();
      const audit = mockAuditRepo();
      const executor = fakeExecutor('listing', () => ({ status: 'done' }));

      const service = new PostAcquisitionService(repo, audit, [executor], {
        enabled: false,
        dryRun: true,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.enabled).toBe(false);
      expect(result.steps).toEqual([]);
      expect(executor.execute).not.toHaveBeenCalled();
      expect(audit.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'automation_disabled', domain: 'example.com' }),
      );
    });
  });

  describe('run', () => {
    it('executes steps in order and journals outcomes', async () => {
      const repo = mockRepo();
      repo.upsert.mockImplementation(async (input: { domain: string; step: string }) =>
        journalRow(input),
      );
      const audit = mockAuditRepo();

      const listing = fakeExecutor('listing', () => ({
        status: 'done',
        message: 'listed on manual',
        detail: { listingId: 5 },
      }));

      const service = new PostAcquisitionService(repo, audit, [listing], {
        enabled: true,
        dryRun: false,
      });

      const result = await service.run('example.com', 'purchase');

      // dns/parking have no executor -> skipped; portfolio is done by the caller;
      // listing executes and reports done.
      expect(result.steps.map((s) => [s.step, s.status])).toEqual([
        ['portfolio', 'skipped'],
        ['site', 'skipped'],
        ['indexing', 'skipped'],
        ['dns', 'skipped'],
        ['parking', 'skipped'],
        ['listing', 'done'],
      ]);
      expect(listing.execute).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'example.com', source: 'purchase', dryRun: false }),
      );
      expect(repo.markDone).toHaveBeenCalledWith(6, { listingId: 5 });
      expect(audit.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'step_listing_done' }),
      );
    });

    it('is idempotent: a step already done is not re-executed', async () => {
      const repo = mockRepo();
      const doneStep = {
        id: 3,
        domain: 'example.com',
        step: 'listing',
        status: 'done',
        attempts: 1,
        source: 'purchase',
        pipelineRunId: null,
        detailJson: null,
        lastError: null,
        createdAt: '2026-01-01 00:00:00',
        updatedAt: '2026-01-01 00:00:00',
      };
      repo.findByDomainAndStep.mockResolvedValue(doneStep);
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));

      const service = new PostAcquisitionService(repo, mockAuditRepo(), [listing], {
        enabled: true,
      });

      const result = await service.run('example.com', 'purchase');

      expect(listing.execute).not.toHaveBeenCalled();
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(result.steps.find((s) => s.step === 'listing')?.status).toBe('done');
      expect(result.steps.find((s) => s.step === 'listing')?.message).toBe('already completed');
    });

    it('halts the chain when a step fails', async () => {
      const repo = mockRepo();
      repo.upsert.mockImplementation(async (input: { domain: string; step: string }) =>
        journalRow(input),
      );
      const audit = mockAuditRepo();

      const dns = fakeExecutor('dns', () => ({
        status: 'failed',
        error: 'nameserver update rejected',
      }));
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));

      const service = new PostAcquisitionService(repo, audit, [dns, listing], { enabled: true });

      const result = await service.run('example.com', 'purchase');

      expect(result.steps.find((s) => s.step === 'dns')?.status).toBe('failed');
      // listing is downstream of dns: it must never run.
      expect(listing.execute).not.toHaveBeenCalled();
      expect(repo.markFailed).toHaveBeenCalledWith(4, 'nameserver update rejected');
      expect(audit.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'step_dns_failed' }),
      );
    });

    it('marks a thrown step error as failed and halts', async () => {
      const repo = mockRepo();
      const listing = fakeExecutor('listing', () => {
        throw new Error('marketplace timeout');
      });

      const service = new PostAcquisitionService(repo, mockAuditRepo(), [listing], {
        enabled: true,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.steps.find((s) => s.step === 'listing')?.message).toBe('marketplace timeout');
      expect(repo.markFailed).toHaveBeenCalledWith(expect.any(Number), 'marketplace timeout');
    });

    it('records a skipped step without halting the chain', async () => {
      const repo = mockRepo();
      repo.upsert.mockImplementation(async (input: { domain: string; step: string }) =>
        journalRow(input),
      );

      const parking = fakeExecutor('parking', () => ({ status: 'skipped', reason: 'dry_run' }));
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));

      const service = new PostAcquisitionService(repo, mockAuditRepo(), [parking, listing], {
        enabled: true,
        dryRun: true,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.steps.find((s) => s.step === 'parking')?.status).toBe('skipped');
      expect(listing.execute).toHaveBeenCalled(); // skipped steps do not halt
      expect(repo.markSkipped).toHaveBeenCalledWith(5, 'dry_run');
    });
  });

  describe('tenant opt-in gate (Phase 0)', () => {
    it('refuses to run when the tenant is opted out and audits the refusal', async () => {
      const repo = mockRepo();
      const audit = mockAuditRepo();
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));
      const settingsRepo = mockSettingsRepo({ enabled: false, dryRun: true });

      const service = new PostAcquisitionService(repo, audit, [listing], {
        enabled: true,
        dryRun: false,
        settingsRepo,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.enabled).toBe(false);
      expect(result.refusedBy).toBe('tenant_switch');
      expect(result.steps).toEqual([]);
      expect(listing.execute).not.toHaveBeenCalled();
      expect(audit.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tenant_automation_disabled', domain: 'example.com' }),
      );
    });

    it('the global kill switch wins over an enabled tenant', async () => {
      const repo = mockRepo();
      const audit = mockAuditRepo();
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));
      const settingsRepo = mockSettingsRepo({ enabled: true, dryRun: false });

      const service = new PostAcquisitionService(repo, audit, [listing], {
        enabled: false,
        dryRun: false,
        settingsRepo,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.enabled).toBe(false);
      expect(result.refusedBy).toBe('global_kill_switch');
      expect(listing.execute).not.toHaveBeenCalled();
    });

    it('env dry-run forces simulation even when the tenant asked for live execution', async () => {
      const repo = mockRepo();
      repo.upsert.mockImplementation(async (input: { domain: string; step: string }) =>
        journalRow(input),
      );
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));
      const settingsRepo = mockSettingsRepo({ enabled: true, dryRun: false });

      const service = new PostAcquisitionService(repo, mockAuditRepo(), [listing], {
        enabled: true,
        dryRun: true,
        settingsRepo,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.enabled).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(listing.execute).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    });

    it('runs live only when both switches allow it', async () => {
      const repo = mockRepo();
      repo.upsert.mockImplementation(async (input: { domain: string; step: string }) =>
        journalRow(input),
      );
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));
      const settingsRepo = mockSettingsRepo({ enabled: true, dryRun: false });

      const service = new PostAcquisitionService(repo, mockAuditRepo(), [listing], {
        enabled: true,
        dryRun: false,
        settingsRepo,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.enabled).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(listing.execute).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
    });

    it('getSettingsView combines global, tenant and effective settings', async () => {
      const settingsRepo = mockSettingsRepo({ enabled: true, dryRun: false });
      const service = new PostAcquisitionService(mockRepo(), mockAuditRepo(), [], {
        enabled: true,
        dryRun: true,
        settingsRepo,
      });

      const view = await service.getSettingsView();

      expect(view).toEqual({
        global: { enabled: true, dryRun: true },
        tenant: { enabled: true, dryRun: false },
        effective: { enabled: true, dryRun: true },
      });
    });

    it('updateTenantSettings delegates to the store', async () => {
      const settingsRepo = mockSettingsRepo({ enabled: false, dryRun: true });
      const service = new PostAcquisitionService(mockRepo(), mockAuditRepo(), [], {
        enabled: true,
        settingsRepo,
      });

      const stored = await service.updateTenantSettings({ enabled: true });

      expect(stored).toEqual({ enabled: true, dryRun: true });
      expect(settingsRepo.set).toHaveBeenCalledWith({ enabled: true });
    });

    it('updateTenantSettings throws when no store is configured', async () => {
      const service = new PostAcquisitionService(mockRepo(), mockAuditRepo(), [], {
        enabled: true,
      });
      await expect(service.updateTenantSettings({ enabled: true })).rejects.toThrow(
        /no settings store/,
      );
    });

    it('falls back to env-only behaviour when no settings store is wired', async () => {
      const repo = mockRepo();
      repo.upsert.mockImplementation(async (input: { domain: string; step: string }) =>
        journalRow(input),
      );
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));

      const service = new PostAcquisitionService(repo, mockAuditRepo(), [listing], {
        enabled: true,
        dryRun: false,
      });

      const result = await service.run('example.com', 'purchase');

      expect(result.enabled).toBe(true);
      expect(listing.execute).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
    });
  });

  describe('settings and reset', () => {
    it('exposes the kill switch and dry-run flag', () => {
      const service = new PostAcquisitionService(mockRepo(), mockAuditRepo(), [], {
        enabled: true,
        dryRun: true,
      });
      expect(service.settings).toEqual({ enabled: true, dryRun: true });
    });

    it('resetStep delegates to the repository', async () => {
      const repo = mockRepo();
      const service = new PostAcquisitionService(repo, mockAuditRepo(), [], { enabled: true });
      await service.resetStep('example.com', 'dns');
      expect(repo.resetStep).toHaveBeenCalledWith('example.com', 'dns');
    });

    it('resetAndRun resets every step before running', async () => {
      const repo = mockRepo();
      const service = new PostAcquisitionService(repo, mockAuditRepo(), [], { enabled: true });
      await service.resetAndRun('example.com', 'manual');
      expect(repo.resetDomain).toHaveBeenCalledWith('example.com');
    });
  });

  describe('audit resilience', () => {
    it('a failing audit write never breaks the pipeline', async () => {
      const repo = mockRepo();
      const audit = mockAuditRepo();
      audit.insert.mockRejectedValue(new Error('db locked'));
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));

      const service = new PostAcquisitionService(repo, audit, [listing], { enabled: true });

      const result = await service.run('example.com', 'purchase');
      expect(result.steps.find((s) => s.step === 'listing')?.status).toBe('done');
    });
  });

  describe('per-domain serialization', () => {
    it('serializes two concurrent runs of the same domain', async () => {
      const repo = mockRepo();
      // The step starts 'pending' and only becomes 'done' on the first run;
      // a concurrent second run must not execute it in parallel.
      const rows = new Map<string, { status: string }>();
      repo.findByDomainAndStep.mockImplementation(
        async (_domain: string, step: string) => rows.get(step) ?? null,
      );
      repo.upsert.mockImplementation(async (input: { domain: string; step: string }) => {
        rows.set(input.step, { status: 'pending' });
        return journalRow(input);
      });
      repo.markDone.mockImplementation(async (id: number) => {
        const step = POST_ACQUISITION_STEPS[id - 1];
        const row = rows.get(step as string);
        if (row) row.status = 'done';
      });

      const order: string[] = [];
      const listing = fakeExecutor('listing', () => {
        order.push('listing-start');
        return { status: 'done' };
      });

      const service = new PostAcquisitionService(repo, mockAuditRepo(), [listing], {
        enabled: true,
      });

      await Promise.all([
        service.run('example.com', 'purchase'),
        service.run('example.com', 'purchase'),
      ]);

      // The step executes exactly once: the second run finds it already done.
      expect(listing.execute).toHaveBeenCalledTimes(1);
    });

    it('runs different domains independently', async () => {
      const repo = mockRepo();
      const listing = fakeExecutor('listing', () => ({ status: 'done' }));
      const service = new PostAcquisitionService(repo, mockAuditRepo(), [listing], {
        enabled: true,
      });

      await Promise.all([service.run('a.com', 'purchase'), service.run('b.com', 'purchase')]);

      expect(listing.execute).toHaveBeenCalledTimes(2);
    });
  });
});
