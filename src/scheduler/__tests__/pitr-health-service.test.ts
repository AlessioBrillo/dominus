// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MockDatabaseProvider } from '../../db/provider/mock-adapter.js';
import { PitrHealthService } from '../pitr-health-service.js';

const TEST_DIR = resolve('./data/tmp/pitr-health-test');
const BACKUP_DIR = join(TEST_DIR, 'backups');

function createService(
  provider: MockDatabaseProvider,
  overrides: { walLagMaxBytes?: number; baseBackupMaxAgeHours?: number } = {},
): PitrHealthService {
  return new PitrHealthService({
    provider,
    backupDir: BACKUP_DIR,
    walLagMaxBytes: overrides.walLagMaxBytes ?? 64 * 1024 * 1024,
    baseBackupMaxAgeHours: overrides.baseBackupMaxAgeHours ?? 26,
  });
}

/** Postgres provider whose WAL-lag query returns the given value. */
function providerWithLag(lagBytes: string | null): MockDatabaseProvider {
  const provider = new MockDatabaseProvider('postgres');
  provider.queryOne = <T>(_sql: string, _params?: unknown[]): Promise<T | null> =>
    Promise.resolve({ lag_bytes: lagBytes } as unknown as T);
  return provider;
}

describe('PitrHealthService', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('reports not applicable on the SQLite community edition', async () => {
    const provider = new MockDatabaseProvider('sqlite');
    const service = createService(provider);
    const result = await service.check();
    expect(result.applicable).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('reports archiving inactive when no WAL segment was ever archived', async () => {
    const service = createService(providerWithLag(null));
    const result = await service.check();
    expect(result.walLagBytes).toBeNull();
    expect(result.archivingActive).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no WAL segment');
  });

  it('reports lag above budget as degraded', async () => {
    const service = createService(providerWithLag(String(128 * 1024 * 1024)));
    const result = await service.check();
    expect(result.walLagBytes).toBe(128 * 1024 * 1024);
    expect(result.archivingActive).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('exceeds budget');
  });

  it('coerces numeric BIGINT strings returned by node-postgres', async () => {
    const service = createService(providerWithLag('1048576'));
    const result = await service.check();
    expect(result.walLagBytes).toBe(1048576);
  });

  it('reports a fresh base backup and healthy lag as ok', async () => {
    mkdirSync(join(BACKUP_DIR, 'base-20260812T040000Z'), { recursive: true });
    const service = createService(providerWithLag('4194304'));
    const result = await service.check();
    expect(result.baseBackupAgeHours).not.toBeNull();
    expect(result.baseBackupAgeHours!).toBeLessThan(26);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('reports no base backup as degraded', async () => {
    const service = createService(providerWithLag('0'));
    const result = await service.check();
    expect(result.baseBackupAgeHours).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no base backup');
  });

  it('fires the onCheck hook with the recorded values', async () => {
    const onCheck = vi.fn();
    const service = new PitrHealthService({
      provider: providerWithLag('8388608'),
      backupDir: BACKUP_DIR,
      walLagMaxBytes: 64 * 1024 * 1024,
      baseBackupMaxAgeHours: 26,
      onCheck,
    });
    await service.check();
    expect(onCheck).toHaveBeenCalledTimes(1);
    const recorded = onCheck.mock.calls[0]![0] as { walLagBytes: number; archivingActive: boolean };
    expect(recorded.walLagBytes).toBe(8388608);
    expect(recorded.archivingActive).toBe(true);
  });
});
