import { describe, it, expect, vi } from 'vitest';
import { ApiKeyRepository } from '../api-key-repository.js';
import type { DatabaseProvider, ExecResult } from '../../provider/interface.js';

function mockDb(): DatabaseProvider {
  return {
    exec: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 1 } as ExecResult),
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    transaction: vi.fn(),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    backup: vi.fn(),
    runMigrations: vi.fn(),
    tryLock: vi.fn(),
    unlock: vi.fn(),
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
      tenantId: 'default', name: 'test', keyHash: 'h',
      keyPrefix: 'sk-', role: 'admin', expiresAt: null,
    });
    expect(db.exec).toHaveBeenCalled();
    expect(result.id).toBe(1);
  });

  it('findById returns a row', async () => {
    const db = mockDb();
    vi.mocked(db.queryOne).mockResolvedValue(row);
    await expect(new ApiKeyRepository(db).findById(1)).resolves.not.toBeNull();
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
