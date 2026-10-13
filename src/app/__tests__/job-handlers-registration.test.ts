// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  buildJobHandlers,
  REQUIRED_JOB_TYPES,
  CONDITIONAL_JOB_TYPES,
} from '../composition-root.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { runMigrations } from '../../db/migrator.js';
import type { Config } from '../../config.js';
import type { JobHandler, JobPayload, JobResult } from '../../types/job-queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard for the AUTO_LIST dead-letter defect (ADR-0083):
 * AutoListHandler existed and jobs were enqueued for it after every
 * purchase, but buildWorkerIfEnabled never registered it, so every
 * AUTO_LIST job dead-lettered with "No handler registered".
 *
 * The fix has two halves — registering the handlers, and asserting the
 * registered set matches REQUIRED_JOB_TYPES so the next job type cannot
 * be added without wiring it up.
 */
function buildWithMigrations(): JobHandler<JobPayload, JobResult>[] {
  const rawDb = new Database(':memory:');
  runMigrations(rawDb);
  const provider = new SqliteProvider(rawDb);

  const config = {
    PUBLIC_SCORES_RETENTION_DAYS: 90,
    EVENTS_RETENTION_DAYS: 180,
    AUTOMATION_AUDIT_RETENTION_DAYS: 90,
  } as unknown as Config;

  return buildJobHandlers({
    config,
    db: rawDb,
    provider,
    // The handlers are only constructed here; their dependencies are
    // fakes because this test asserts registration, not execution.
    runService: {} as never,
    portfolioManager: {
      getRescoreService: () => ({}),
    } as never,
    scoringRepo: {} as never,
    currentWeights: {} as never,
    outcomeRepo: {} as never,
    backupService: {} as never,
    candidateRepo: {} as never,
    pipelineRunsRepo: {} as never,
    providerCacheRepo: {} as never,
    jobQueueRepo: {} as never,
    watchlistService: {} as never,
    alertEngine: {} as never,
    autoTuner: undefined,
    portfolioHealthcheckService: {} as never,
    autoListingService: {} as never,
    postAcquisitionService: {} as never,
    automationAuditRepo: {} as never,
  });
}

describe('Job handler registration (worker wiring)', () => {
  it('registers every job type the queue can enqueue', () => {
    const handlers = buildWithMigrations();
    const registered = handlers.map((h) => h.jobType).sort();

    expect(registered).toEqual([...REQUIRED_JOB_TYPES].sort());
  });

  it('registers the AUTO_LIST handler (the defect fixed in ADR-0083)', () => {
    const handlers = buildWithMigrations();
    expect(handlers.map((h) => h.jobType)).toContain('AUTO_LIST');
  });

  it('registers the POST_ACQUISITION handler used by the automation pipeline', () => {
    const handlers = buildWithMigrations();
    expect(handlers.map((h) => h.jobType)).toContain('POST_ACQUISITION');
  });

  it('registers no handler twice', () => {
    const handlers = buildWithMigrations();
    const types = handlers.map((h) => h.jobType);
    expect(new Set(types).size).toBe(types.length);
  });

  it('omits WEIGHT_TUNE when the auto-tuner is disabled', () => {
    const handlers = buildWithMigrations();
    // autoTuner is undefined in the fixture: the tuner is opt-in
    // (AUTO_TUNE_ENABLED=false by default).
    expect(handlers.map((h) => h.jobType)).not.toContain('WEIGHT_TUNE');
  });
});

describe('REQUIRED_JOB_TYPES', () => {
  it('matches the JobType union in src/types/job-queue.ts', () => {
    // Reads the real source (same technique as the OpenAPI coverage test)
    // so adding a job type to the union without registering a handler
    // fails here instead of dead-lettering in production.
    const source = readFileSync(join(__dirname, '..', '..', 'types', 'job-queue.ts'), 'utf8');
    const unionMatch = source.match(/export type JobType =\s*([\s\S]*?);/);
    expect(unionMatch).not.toBeNull();
    const declared = [...(unionMatch?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)]
      .map((m) => m[1] ?? '')
      .filter((t) => !(CONDITIONAL_JOB_TYPES as readonly string[]).includes(t))
      .sort();
    expect([...REQUIRED_JOB_TYPES].sort()).toEqual(declared);
  });
});
