import type { Redis } from 'ioredis';
import { getRedisClient, type RedisClient } from './redis-client.js';

const LOCK_SCRIPT = `
  local key = KEYS[1]
  local ttl = tonumber(ARGV[1])
  local worker = ARGV[2]
  local val = redis.call('get', key)
  if val == false then
    redis.call('set', key, worker, 'PX', ttl, 'NX')
    return 1
  elseif val == worker then
    redis.call('pexpire', key, ttl)
    return 1
  end
  return 0
`;

const RENEW_SCRIPT = `
  local key = KEYS[1]
  local ttl = tonumber(ARGV[1])
  local worker = ARGV[2]
  local val = redis.call('get', key)
  if val == worker then
    redis.call('pexpire', key, ttl)
    return 1
  end
  return 0
`;

const UNLOCK_SCRIPT = `
  local key = KEYS[1]
  local worker = ARGV[1]
  local val = redis.call('get', key)
  if val == worker then
    redis.call('del', key)
    return 1
  end
  return 0
`;

export class RedisLock {
  readonly #redisClient: RedisClient;
  #workerId: string;

  constructor(redisClient?: RedisClient) {
    this.#redisClient = redisClient ?? getRedisClient();
    this.#workerId = `worker:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  }

  get workerId(): string {
    return this.#workerId;
  }

  async tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    const key = this.#redisClient.prefixed(`lock:${lockName}`);

    return this.#redisClient.withRedis(
      async (redis: Redis) => {
        const result = await redis.eval(LOCK_SCRIPT, 1, key, String(ttlMs), this.#workerId);
        return result === 1;
      },
      async () => false,
    );
  }

  async renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    const key = this.#redisClient.prefixed(`lock:${lockName}`);

    return this.#redisClient.withRedis(
      async (redis: Redis) => {
        const result = await redis.eval(RENEW_SCRIPT, 1, key, String(ttlMs), this.#workerId);
        return result === 1;
      },
      async () => false,
    );
  }

  async unlock(lockName: string): Promise<void> {
    const key = this.#redisClient.prefixed(`lock:${lockName}`);

    await this.#redisClient.withRedis(
      async (redis: Redis) => {
        await redis.eval(UNLOCK_SCRIPT, 1, key, this.#workerId);
      },
      async () => {},
    );
  }

  async shutdown(): Promise<void> {
    await this.#redisClient.shutdown();
  }
}
