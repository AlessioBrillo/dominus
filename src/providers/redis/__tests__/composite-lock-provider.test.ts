import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompositeLockProvider } from '../composite-lock-provider.js';
import type { LockProvider } from '../../../types/lock.js';
import type { RedisClient } from '../redis-client.js';

function createMockLockProvider(
  name: string,
  outcomes?: {
    tryLock?: boolean;
    renewLock?: boolean;
    unlockError?: Error;
    tryLockError?: Error;
  },
): LockProvider {
  return {
    name: name as unknown as string,
    tryLock: vi.fn().mockResolvedValue(outcomes?.tryLock ?? true),
    renewLock: vi.fn().mockResolvedValue(outcomes?.renewLock ?? true),
    unlock: vi.fn().mockResolvedValue(undefined),
  } as unknown as LockProvider;
}

function createRedisClient(isConnected: boolean): RedisClient {
  return {
    isConnected,
    keyPrefix: 'dominus:',
    prefixed: (key: string) => `dominus:${key}`,
  } as unknown as RedisClient;
}

describe('CompositeLockProvider', () => {
  let redisProvider: LockProvider;
  let dbProvider: LockProvider;
  let redisClient: RedisClient;
  let composite: CompositeLockProvider;

  beforeEach(() => {
    redisProvider = createMockLockProvider('RedisLock');
    dbProvider = createMockLockProvider('DatabaseLock');
    redisClient = createRedisClient(true);
    composite = new CompositeLockProvider(
      [
        { name: 'RedisLock', provider: redisProvider },
        { name: 'DatabaseLock', provider: dbProvider },
      ],
      redisClient,
    );
  });

  describe('tryLock', () => {
    it('acquires from first (Redis) provider when available', async () => {
      const result = await composite.tryLock('test-lock', 30_000);
      expect(result).toBe(true);
      expect(redisProvider.tryLock).toHaveBeenCalledWith('test-lock', 30_000);
      expect(dbProvider.tryLock).not.toHaveBeenCalled();
    });

    it('falls back to second provider when first provider refuses', async () => {
      (redisProvider.tryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const result = await composite.tryLock('test-lock', 30_000);
      expect(result).toBe(true);
      expect(dbProvider.tryLock).toHaveBeenCalledWith('test-lock', 30_000);
    });

    it('falls back to second provider when first throws', async () => {
      (redisProvider.tryLock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

      const result = await composite.tryLock('test-lock', 30_000);
      expect(result).toBe(true);
      expect(dbProvider.tryLock).toHaveBeenCalledWith('test-lock', 30_000);
    });

    it('returns false when all providers fail', async () => {
      (redisProvider.tryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (dbProvider.tryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const result = await composite.tryLock('test-lock', 30_000);
      expect(result).toBe(false);
    });

    it('returns false when all providers throw', async () => {
      (redisProvider.tryLock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('err1'));
      (dbProvider.tryLock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('err2'));

      const result = await composite.tryLock('test-lock', 30_000);
      expect(result).toBe(false);
    });

    it('records the owning provider in the lock ownership map', async () => {
      await composite.tryLock('test-lock', 30_000);
      (redisProvider.tryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const stillOwned = await composite.renewLock('test-lock', 30_000);
      expect(stillOwned).toBe(true);
    });

    it('starts from DB provider when Redis is disconnected', async () => {
      const disconnected = createRedisClient(false);
      const comp = new CompositeLockProvider(
        [
          { name: 'RedisLock', provider: redisProvider },
          { name: 'DatabaseLock', provider: dbProvider },
        ],
        disconnected,
      );

      await comp.tryLock('test-lock', 30_000);
      expect(redisProvider.tryLock).not.toHaveBeenCalled();
      expect(dbProvider.tryLock).toHaveBeenCalledWith('test-lock', 30_000);
    });

    it('starts from index 0 when first provider is not Redis named', async () => {
      const fileProvider = createMockLockProvider('FileLock');
      const comp = new CompositeLockProvider(
        [{ name: 'FileLock', provider: fileProvider }],
        redisClient,
      );
      (fileProvider.tryLock as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const result = await comp.tryLock('test-lock', 30_000);
      expect(result).toBe(true);
      expect(fileProvider.tryLock).toHaveBeenCalled();
    });
  });

  describe('renewLock', () => {
    it('delegates to the owning provider', async () => {
      await composite.tryLock('test-lock', 30_000);

      const result = await composite.renewLock('test-lock', 60_000);
      expect(result).toBe(true);
      expect(redisProvider.renewLock).toHaveBeenCalledWith('test-lock', 60_000);
    });

    it('returns false when lock is unknown', async () => {
      const result = await composite.renewLock('unknown-lock', 30_000);
      expect(result).toBe(false);
    });

    it('returns false when owning provider renew fails', async () => {
      await composite.tryLock('test-lock', 30_000);
      (redisProvider.renewLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const result = await composite.renewLock('test-lock', 30_000);
      expect(result).toBe(false);
    });

    it('returns false when owning provider throws', async () => {
      await composite.tryLock('test-lock', 30_000);
      (redisProvider.renewLock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

      const result = await composite.renewLock('test-lock', 30_000);
      expect(result).toBe(false);
      expect(redisProvider.renewLock).toHaveBeenCalledWith('test-lock', 30_000);
    });

    it('delegates to DB provider when Redis was the fallback owner', async () => {
      (redisProvider.tryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      await composite.tryLock('test-lock', 30_000);

      const result = await composite.renewLock('test-lock', 30_000);
      expect(result).toBe(true);
      expect(dbProvider.renewLock).toHaveBeenCalledWith('test-lock', 30_000);
      expect(redisProvider.renewLock).not.toHaveBeenCalled();
    });
  });

  describe('unlock', () => {
    it('delegates to the owning provider', async () => {
      await composite.tryLock('test-lock', 30_000);

      await composite.unlock('test-lock');
      expect(redisProvider.unlock).toHaveBeenCalledWith('test-lock');
    });

    it('removes ownership after unlock', async () => {
      await composite.tryLock('test-lock', 30_000);
      await composite.unlock('test-lock');

      const result = await composite.renewLock('test-lock', 30_000);
      expect(result).toBe(false);
    });

    it('is a no-op for unknown locks', async () => {
      await composite.unlock('unknown-lock');
      expect(redisProvider.unlock).not.toHaveBeenCalled();
      expect(dbProvider.unlock).not.toHaveBeenCalled();
    });

    it('still removes ownership when provider unlock throws', async () => {
      await composite.tryLock('test-lock', 30_000);
      (redisProvider.unlock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

      await composite.unlock('test-lock');

      const result = await composite.renewLock('test-lock', 30_000);
      expect(result).toBe(false);
    });
  });

  describe('clearLockOwners', () => {
    it('clears all tracked lock owners', async () => {
      await composite.tryLock('lock-a', 30_000);
      await composite.tryLock('lock-b', 30_000);
      (redisProvider.tryLock as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      composite.clearLockOwners();

      const resultA = await composite.renewLock('lock-a', 30_000);
      const resultB = await composite.renewLock('lock-b', 30_000);
      expect(resultA).toBe(false);
      expect(resultB).toBe(false);
    });
  });

  describe('constructor', () => {
    it('creates with single provider and no Redis client', () => {
      const single = new CompositeLockProvider([
        { name: 'FileLock', provider: createMockLockProvider('FileLock') },
      ]);
      expect(single).toBeDefined();
    });
  });
});
