import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { DistributedCircuitBreaker } from '../distributed-circuit-breaker.js';
import type { RedisClient } from '../redis-client.js';

function createMockRedis(): Redis {
  const multiChain = {
    hset: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    eval: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue('closed'),
    hset: vi.fn(),
    del: vi.fn(),
    multi: vi.fn(() => multiChain),
    expire: vi.fn(),
    incr: vi.fn(),
    status: 'ready',
  } as unknown as Redis;
}

function createMockRedisClient(mockRedis?: Redis): RedisClient {
  const redis = mockRedis ?? createMockRedis();
  return {
    client: redis,
    isConnected: true,
    keyPrefix: 'dominus:',
    prefixed: (key: string) => `dominus:${key}`,
    withRedis: vi.fn(
      async <T>(fn: (r: Redis) => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
        try {
          return await fn(redis);
        } catch {
          return fallback();
        }
      },
    ),
    ping: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as RedisClient;
}

describe('DistributedCircuitBreaker', () => {
  let mockRedis: Redis;
  let mockClient: RedisClient;
  let breaker: DistributedCircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    mockRedis = createMockRedis();
    mockClient = createMockRedisClient(mockRedis);
    breaker = new DistributedCircuitBreaker('test', {}, mockClient);
  });

  describe('constructor', () => {
    it('sets initial state to closed', () => {
      expect(breaker.state).toBe('closed');
    });

    it('uses partial policy with defaults', () => {
      const custom = new DistributedCircuitBreaker('custom', { failureThreshold: 3 }, mockClient);
      expect(custom.state).toBe('closed');
    });
  });

  describe('cooldownMs', () => {
    it('returns the configured cooldown', () => {
      expect(breaker.cooldownMs).toBe(120_000);
    });
  });

  describe('allow()', () => {
    it('returns true from cache when state is closed and cache is valid', async () => {
      (mockRedis.hget as ReturnType<typeof vi.fn>).mockResolvedValue('closed');
      await breaker.allow();
      expect(mockRedis.eval).toHaveBeenCalled();

      vi.clearAllMocks();

      const result = await breaker.allow();
      expect(result).toBe(true);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('calls Redis LUA_ALLOW when cache is stale', async () => {
      vi.advanceTimersByTime(3000);

      const result = await breaker.allow();
      expect(result).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'dominus:cb:test',
        '120000',
      );
    });

    it('returns false when LUA_ALLOW returns 0', async () => {
      vi.advanceTimersByTime(3000);
      mockRedis.eval = vi.fn().mockResolvedValue(0);
      (mockRedis.hget as ReturnType<typeof vi.fn>).mockResolvedValue('open');

      const result = await breaker.allow();
      expect(result).toBe(false);
    });

    it('updates cached state after a stale check', async () => {
      vi.advanceTimersByTime(3000);

      await breaker.allow();
      expect(breaker.state).toBe('closed');
    });

    it('falls back to true when Redis throws', async () => {
      mockRedis.eval = vi.fn().mockRejectedValue(new Error('connection lost'));

      const result = await breaker.allow();
      expect(result).toBe(true);
    });
  });

  describe('onSuccess()', () => {
    it('records success via LUA_RECORD_SUCCESS and updates cached state', async () => {
      mockRedis.eval = vi.fn().mockResolvedValue('closed');

      await breaker.onSuccess();
      expect(breaker.state).toBe('closed');
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'dominus:cb:test',
        '60000',
      );
    });

    it('updates cache timestamp', async () => {
      vi.advanceTimersByTime(100);
      mockRedis.eval = vi.fn().mockResolvedValue('closed');

      await breaker.onSuccess();

      expect(breaker.state).toBe('closed');
    });

    it('does not throw when Redis fails', async () => {
      const disconnectedClient = createMockRedisClient();
      (disconnectedClient.withRedis as ReturnType<typeof vi.fn>).mockImplementation(
        async (_fn: unknown, fallback: () => Promise<void>) => fallback(),
      );
      const fb = new DistributedCircuitBreaker('test', {}, disconnectedClient);
      await expect(fb.onSuccess()).resolves.toBeUndefined();
    });
  });

  describe('onFailure()', () => {
    it('transitions to open when threshold met', async () => {
      mockRedis.eval = vi.fn().mockResolvedValue('open');

      await breaker.onFailure();
      expect(breaker.state).toBe('open');
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'dominus:cb:test',
        '60000',
        '5',
        '120000',
      );
    });

    it('stays closed when below threshold', async () => {
      mockRedis.eval = vi.fn().mockResolvedValue('closed');

      await breaker.onFailure();
      expect(breaker.state).toBe('closed');
    });

    it('falls back to closed when Redis throws', async () => {
      mockRedis.eval = vi.fn().mockRejectedValue(new Error('connection lost'));

      await breaker.onFailure();
      expect(breaker.state).toBe('closed');
    });
  });

  describe('forceOpen()', () => {
    it('sets cached state to open immediately', async () => {
      await breaker.forceOpen();
      expect(breaker.state).toBe('open');
    });

    it('writes state to Redis via multi', async () => {
      await breaker.forceOpen();
      expect(mockRedis.multi).toHaveBeenCalled();
    });
  });

  describe('forceClosed()', () => {
    it('resets cached state to closed', async () => {
      await breaker.forceOpen();
      await breaker.forceClosed();
      expect(breaker.state).toBe('closed');
    });

    it('deletes the Redis key', async () => {
      await breaker.forceClosed();
      expect(mockRedis.del).toHaveBeenCalledWith('dominus:cb:test');
    });

    it('allows requests after reset', async () => {
      await breaker.forceOpen();
      await breaker.forceClosed();
      const result = await breaker.allow();
      expect(result).toBe(true);
    });
  });

  describe('reset()', () => {
    it('clears cached state', () => {
      const b = new DistributedCircuitBreaker('r', {}, mockClient);
      expect(b.state).toBe('closed');
    });
  });
});
