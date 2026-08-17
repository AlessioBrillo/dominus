// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { MockDatabaseProvider } from '../../db/provider/mock-adapter.js';
import { PitrHealthService } from '../pitr-health-service.js';

function createService(
  provider: MockDatabaseProvider,
  overrides: { walLagMaxBytes?: number; baseBackupMaxAgeHours?: number } = {},
): PitrHealthService {
  return new PitrHealthService({
    provider,
    walLagMaxBytes: overrides.walLagMaxBytes ?? 64 * 1024 * 1024,
    baseBackupMaxAgeHours: overrides.baseBackupMaxAgeHours ?? 26,
  });
}

interface ManifestRow {
  finished_at: string | Date;
  base_name: string;
  size_bytes: string | number;
  host: string;
}

/**
 * Postgres provider whose queries branch on the SQL: the WAL-lag query
 * returns the given lag, the manifest query returns the given row.
 */
function providerWithState(
  lagBytes: string | null,
  manifestRow: ManifestRow | null,
): MockDatabaseProvider {
  const provider = new MockDatabaseProvider('postgres');
  provider.queryOne = <T>(sql: string, _params?: unknown[]): Promise<T | null> => {
    if (sql.includes('pitr_health')) {
      return Promise.resolve(manifestRow as unknown as T);
    }
    return Promise.resolve({ lag_bytes: lagBytes } as unknown as T);
  };
  return provider;
}

const FRESH_MANIFEST: ManifestRow = {
  finished_at: new Date(),
  base_name: 'base-20260817T040000Z',
  size_bytes: 125829120,
  host: 'db-1',
};

describe('PitrHealthService', () => {
  it('reports not applicable on the SQLite community edition', async () => {
    const provider = new MockDatabaseProvider('sqlite');
    const service = createService(provider);
    const result = await service.check();
    expect(result.applicable).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('reports archiving inactive when no WAL segment was ever archived', async () => {
    const service = createService(providerWithState(null, FRESH_MANIFEST));
    const result = await service.check();
    expect(result.walLagBytes).toBeNull();
    expect(result.archivingActive).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no WAL segment');
  });

  it('reports lag above budget as degraded', async () => {
    const service = createService(providerWithState(String(128 * 1024 * 1024), FRESH_MANIFEST));
    const result = await service.check();
    expect(result.walLagBytes).toBe(128 * 1024 * 1024);
    expect(result.archivingActive).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('exceeds budget');
  });

  it('coerces numeric BIGINT strings returned by node-postgres', async () => {
    const service = createService(providerWithState('1048576', FRESH_MANIFEST));
    const result = await service.check();
    expect(result.walLagBytes).toBe(1048576);
  });

  it('reports a fresh manifest row and healthy lag as ok', async () => {
    const service = createService(providerWithState('4194304', FRESH_MANIFEST));
    const result = await service.check();
    expect(result.baseBackupAgeHours).not.toBeNull();
    expect(result.baseBackupAgeHours!).toBeLessThan(26);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('coerces an ISO timestamp string returned as finished_at', async () => {
    const service = createService(
      providerWithState('4194304', {
        ...FRESH_MANIFEST,
        finished_at: new Date().toISOString(),
      }),
    );
    const result = await service.check();
    expect(result.baseBackupAgeHours).not.toBeNull();
    expect(result.baseBackupAgeHours!).toBeLessThan(26);
  });

  it('reports an old manifest row as degraded', async () => {
    const service = createService(
      providerWithState('4194304', {
        ...FRESH_MANIFEST,
        finished_at: new Date(Date.now() - 3 * 24 * 3_600_000),
      }),
    );
    const result = await service.check();
    expect(result.baseBackupAgeHours).not.toBeNull();
    expect(result.baseBackupAgeHours!).toBeGreaterThan(26);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('old');
  });

  it('reports an empty manifest as degraded (no base backup anchor)', async () => {
    const service = createService(providerWithState('0', null));
    const result = await service.check();
    expect(result.baseBackupAgeHours).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no base backup');
  });

  it('reports an unreadable manifest as degraded without throwing', async () => {
    const provider = new MockDatabaseProvider('postgres');
    provider.queryOne = <T>(sql: string): Promise<T | null> => {
      if (sql.includes('pitr_health')) return Promise.reject(new Error('relation does not exist'));
      return Promise.resolve({ lag_bytes: '0' } as unknown as T);
    };
    const service = createService(provider);
    const result = await service.check();
    expect(result.baseBackupAgeHours).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no base backup');
  });

  it('fires the onCheck hook with the recorded values', async () => {
    const onCheck = vi.fn();
    const service = new PitrHealthService({
      provider: providerWithState('8388608', FRESH_MANIFEST),
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
