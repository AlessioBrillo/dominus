// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { ApiKeyRepository } from '../api-key-repository.js';
import type { DatabaseProvider, ExecResult } from '../../provider/interface.js';

function mockDb(): DatabaseProvider {
  return {
    dialect: 'sqlite',
    exec: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 1 } as ExecResult),
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    transaction: vi.fn(),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    backup: vi.fn(),
    runMigrations: vi.fn(),
    tryLock: vi.fn(),
    renewLock: vi.fn(),
    unlock: vi.fn(),
    tryLockWithFence: vi.fn().mockResolvedValue({ acquired: true, fenceToken: 'mock-fence-token' }),
    renewLockWithFence: vi.fn().mockResolvedValue(true),
    unlockWithFence: vi.fn().mockResolvedValue(undefined),
  };
}

const row = {
  id: 1,
  tenant_id: 'default',
  name: 'test',
  key_hash: 'h',
  key_prefix: 'sk-',
  role: 'admin',
  expires_at: null,
  last_used_at: null,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

describe('ApiKeyRepository', () => {
  it('create calls exec then findById', async () => {
    const db = mockDb();
    vi.mocked(db.queryOne).mockResolvedValue(row);
    const repo = new ApiKeyRepository(db);
    const result = await repo.create({
      tenantId: 'default',
      name: 'test',
      keyHash: 'h',
      keyPrefix: 'sk-',
      role: 'admin',
      expiresAt: null,
    });
    expect(db.exec).toHaveBeenCalled();
    expect(result.id).toBe(1);
  });

  it('findById returns a row', async () => {
    const db = mockDb();
    vi.mocked(db.queryOne).mockResolvedValue(row);
    await expect(new ApiKeyRepository(db).findById(1)).resolves.not.toBeNull();
  });

  it('create reads the row back for the tenant it wrote to', async () => {
    // The bootstrap of a Cloud deployment writes a key outside any tenant
    // context (`dominus keys create --tenant <id>`). Reading the row back
    // with the AMBIENT context ('default') found nothing, and the command
    // crashed on a null row: the operator could not mint the first key.
    const db = mockDb();
    vi.mocked(db.queryOne).mockResolvedValue({ ...row, tenant_id: 'tenant-a' });
    const repo = new ApiKeyRepository(db);
    const result = await repo.create({
      tenantId: 'tenant-a',
      name: 'ops',
      keyHash: 'h',
      keyPrefix: 'sk-',
      role: 'admin',
      expiresAt: null,
    });
    expect(result.tenantId).toBe('tenant-a');
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('api_keys'), [1, 'tenant-a']);
  });

  it('create fails loudly when the row cannot be read back', async () => {
    const db = mockDb();
    vi.mocked(db.queryOne).mockResolvedValue(null);
    await expect(
      new ApiKeyRepository(db).create({
        tenantId: 'tenant-a',
        name: 'ops',
        keyHash: 'h',
        keyPrefix: 'sk-',
        role: 'admin',
        expiresAt: null,
      }),
    ).rejects.toThrow(/could not be read back/);
  });

  it('findByPrefix returns a row', async () => {
    const db = mockDb();
    vi.mocked(db.queryOne).mockResolvedValue(row);
    await expect(new ApiKeyRepository(db).findByPrefix('sk-')).resolves.not.toBeNull();
  });

  it('findByTenant returns rows', async () => {
    const db = mockDb();
    vi.mocked(db.query).mockResolvedValue([row]);
    const results = await new ApiKeyRepository(db).findByTenant('default');
    expect(results).toHaveLength(1);
  });

  it('updateLastUsed calls exec', async () => {
    const db = mockDb();
    await new ApiKeyRepository(db).updateLastUsed(1);
    expect(db.exec).toHaveBeenCalled();
  });

  it('revoke calls exec', async () => {
    const db = mockDb();
    await new ApiKeyRepository(db).revoke(1);
    expect(db.exec).toHaveBeenCalled();
  });
});
