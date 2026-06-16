import type { BackupService } from '../../scheduler/backup-service.js';
import type { BackupPayload, BackupResult, JobHandler } from '../../types/job-queue.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface BackupHandlerDeps {
  backupService: BackupService;
}

export class BackupHandler implements JobHandler<BackupPayload, BackupResult> {
  readonly jobType = 'BACKUP' as const;

  constructor(private readonly deps: BackupHandlerDeps) {}

  async handle(payload: BackupPayload): Promise<BackupResult> {
    logger.info({ retentionDays: payload.retentionDays }, 'BackupHandler: starting backup');

    const result = await this.deps.backupService.create();
    let prunedCount = 0;

    if (payload.retentionDays !== undefined && payload.retentionDays > 0) {
      prunedCount = this.deps.backupService.prune();
    }

    logger.info(
      {
        backupPath: result.path,
        sizeBytes: result.sizeBytes,
        durationMs: result.durationMs,
        prunedCount,
      },
      'BackupHandler: completed',
    );
    return {
      backupPath: result.path,
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
      prunedCount,
    };
  }
}
