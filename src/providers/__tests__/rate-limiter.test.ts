import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';

describe('RateLimiter', () => {
  describe('unlimited', () => {
    it('never blocks acquire()', async () => {
      const limiter = RateLimiter.unlimited();
      const results = await Promise.all(Array.from({ length: 100 }, () => limiter.acquire()));
      expect(results).toHaveLength(100);
    });

    it('executes throttle() immediately', async () => {
      const limiter = RateLimiter.unlimited();
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await limiter.throttle(fn);
      expect(result).toBe('ok');
    });
  });

  describe('token bucket', () => {
    it('allows burst up to maxTokens', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, tokensPerInterval: 5, intervalMs: 1000 });
      for (let i = 0; i < 5; i++) {
        await expect(limiter.acquire()).resolves.toBeUndefined();
      }
    });

    it('blocks when tokens exhausted, then resumes after interval', async () => {
      const limiter = new RateLimiter({ maxTokens: 1, tokensPerInterval: 1, intervalMs: 20 });

      await limiter.acquire();

      const blocked = limiter.acquire();
      const raced = await Promise.race([
        blocked.then(() => 'resolved'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 5)),
      ]);
      expect(raced).toBe('timeout');

      await blocked;
    });

    it('throttle wraps fn with acquire/release', async () => {
      const limiter = new RateLimiter({ maxTokens: 2, tokensPerInterval: 2, intervalMs: 1000 });
      const fn = vi.fn().mockResolvedValue(42);
      const result = await limiter.throttle(fn);
      expect(result).toBe(42);
    });

    it('processes queued acquires in order after refill', async () => {
      const limiter = new RateLimiter({ maxTokens: 1, tokensPerInterval: 2, intervalMs: 40 });

      await limiter.acquire();
      const order: number[] = [];
      const p1 = limiter.acquire().then(() => order.push(1));
      const p2 = limiter.acquire().then(() => order.push(2));

      await p1;
      expect(order).toEqual([1]);

      await p2;
      expect(order).toEqual([1, 2]);
    });

    it('returns true from tryAcquire when token available', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, tokensPerInterval: 5, intervalMs: 1000 });
      expect(await tryAcquire(limiter)).toBe(true);
    });

    it('returns false from tryAcquire when token exhausted', async () => {
      const limiter = new RateLimiter({ maxTokens: 1, tokensPerInterval: 1, intervalMs: 1000 });
      await limiter.acquire();
      expect(await tryAcquire(limiter)).toBe(false);
    });
  });
});

async function tryAcquire(limiter: RateLimiter): Promise<boolean> {
  const result = await Promise.race([
    limiter.acquire().then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 30)),
  ]);
  return result;
}
