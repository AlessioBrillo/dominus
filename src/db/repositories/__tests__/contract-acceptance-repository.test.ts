// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { ContractAcceptanceRepository } from '../contract-acceptance-repository.js';

describe('ContractAcceptanceRepository.hasForTenant', () => {
  let repo: ContractAcceptanceRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    runMigrations(db);
    repo = new ContractAcceptanceRepository(new SqliteProvider(db));
  });

  it('matches the stored content hash, not just the version', async () => {
    await repo.create({
      email: 'buyer@example.com',
      tenantId: 'tenant-1',
      purpose: 'checkout',
      documentSlug: 'terms',
      documentVersion: '2026-11-24',
      contentHash: 'a'.repeat(64),
    });
    const has = (hash: string): Promise<boolean> =>
      repo.hasForTenant('tenant-1', 'checkout', 'terms', '2026-11-24', hash, 86_400_000);

    expect(await has('a'.repeat(64))).toBe(true);
    expect(await has('b'.repeat(64))).toBe(false);
  });

  it('does not match an expired acceptance', async () => {
    await repo.create({
      email: 'buyer@example.com',
      tenantId: 'tenant-1',
      purpose: 'checkout',
      documentSlug: 'terms',
      documentVersion: '2026-11-24',
      contentHash: 'a'.repeat(64),
    });
    expect(
      await repo.hasForTenant('tenant-1', 'checkout', 'terms', '2026-11-24', 'a'.repeat(64), -1000),
    ).toBe(false);
  });
});
