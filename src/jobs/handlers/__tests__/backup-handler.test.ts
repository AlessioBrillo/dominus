/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { BackupHandler } from '../backup-handler.js';

describe('BackupHandler', () => {
  it('creates backup and prunes when retentionDays provided', async () => {
    const backupService = {
      create: vi
        .fn()
        .mockResolvedValue({ path: '/tmp/backup.db', sizeBytes: 1024, durationMs: 500 }),
      prune: vi.fn().mockReturnValue(3),
    };
    const handler = new BackupHandler({ backupService } as any);

    const result = await handler.handle({ retentionDays: 30 });

    expect(backupService.create).toHaveBeenCalled();
    expect(backupService.prune).toHaveBeenCalled();
    expect(result.backupPath).toBe('/tmp/backup.db');
    expect(result.sizeBytes).toBe(1024);
    expect(result.prunedCount).toBe(3);
  });

  it('skips pruning when retentionDays not provided', async () => {
    const backupService = {
      create: vi
        .fn()
        .mockResolvedValue({ path: '/tmp/backup.db', sizeBytes: 512, durationMs: 200 }),
      prune: vi.fn(),
    };
    const handler = new BackupHandler({ backupService } as any);

    const result = await handler.handle({});

    expect(backupService.create).toHaveBeenCalled();
    expect(backupService.prune).not.toHaveBeenCalled();
    expect(result.prunedCount).toBe(0);
  });

  it('skips pruning when retentionDays is 0', async () => {
    const backupService = {
      create: vi.fn().mockResolvedValue({ path: '/tmp/x', sizeBytes: 0, durationMs: 0 }),
      prune: vi.fn(),
    };
    const handler = new BackupHandler({ backupService } as any);

    const result = await handler.handle({ retentionDays: 0 });

    expect(backupService.prune).not.toHaveBeenCalled();
    expect(result.prunedCount).toBe(0);
  });

  it('has the correct jobType', () => {
    const handler = new BackupHandler({ backupService: {} } as any);
    expect(handler.jobType).toBe('BACKUP');
  });
});
