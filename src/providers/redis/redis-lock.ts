// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from 'ioredis';
import { getRedisClient, type RedisClient } from './redis-client.js';
import { randomUUID } from 'node:crypto';
import type { LockMetadata } from '../../types/lock.js';

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

/**
 * Lua script for fenced lock acquisition with metadata.
 * Returns: acquired (0/1), fenceToken (string or nil)
 * The fence token is a UUID generated client-side and stored with the lock.
 * Lock value format: worker:fenceToken:metadataJson
 */
const FENCED_LOCK_SCRIPT = `
  local key = KEYS[1]
  local ttl = tonumber(ARGV[1])
  local worker = ARGV[2]
  local fenceToken = ARGV[3]
  local metadata = ARGV[4] or '{}'
  local val = redis.call('get', key)
  if val == false then
    redis.call('set', key, worker .. ':' .. fenceToken .. ':' .. metadata, 'PX', ttl, 'NX')
    return {1, fenceToken}
  elseif string.find(val, '^' .. worker .. ':') == 1 then
    -- Same worker already holds the lock, refresh TTL
    redis.call('pexpire', key, ttl)
    -- Extract existing fence token
    local _, _, existingToken = string.find(val, '^[^:]+:([^:]+):')
    return {1, existingToken}
  end
  return {0, nil}
`;

/**
 * Lua script for fenced lock renewal with metadata.
 * Only renews if the fenceToken matches the current holder.
 */
const FENCED_RENEW_SCRIPT = `
  local key = KEYS[1]
  local ttl = tonumber(ARGV[1])
  local worker = ARGV[2]
  local fenceToken = ARGV[3]
  local metadata = ARGV[4] or '{}'
  local val = redis.call('get', key)
  if val == false then
    return 0
  end
  local expectedPrefix = worker .. ':' .. fenceToken .. ':'
  if string.find(val, '^' .. expectedPrefix) == 1 then
    redis.call('set', key, worker .. ':' .. fenceToken .. ':' .. metadata, 'PX', ttl)
    return 1
  end
  return 0
`;

/**
 * Lua script for fenced unlock with metadata.
 * Only deletes if the fenceToken matches the current holder.
 */
const FENCED_UNLOCK_SCRIPT = `
  local key = KEYS[1]
  local worker = ARGV[1]
  local fenceToken = ARGV[2]
  local val = redis.call('get', key)
  if val == false then
    return 0
  end
  local expectedPrefix = worker .. ':' .. fenceToken .. ':'
  if string.find(val, '^' .. expectedPrefix) == 1 then
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

  #encodeMetadata(metadata?: LockMetadata): string {
    if (!metadata) return '{}';
    return JSON.stringify({
      runId: metadata.runId,
      stage: metadata.stage,
      priority: metadata.priority,
      tenantId: metadata.tenantId,
      acquiredAt: metadata.acquiredAt ?? new Date().toISOString(),
    });
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

  async tryLockWithFence(
    lockName: string,
    ttlMs: number,
    metadata?: LockMetadata,
  ): Promise<{ acquired: boolean; fenceToken: string | undefined }> {
    const key = this.#redisClient.prefixed(`lock:${lockName}`);
    const fenceToken = randomUUID();
    const metadataJson = this.#encodeMetadata(metadata);

    return this.#redisClient.withRedis(
      async (redis: Redis) => {
        const result = (await redis.eval(
          FENCED_LOCK_SCRIPT,
          1,
          key,
          String(ttlMs),
          this.#workerId,
          fenceToken,
          metadataJson,
        )) as [number, string | null];
        return {
          acquired: result[0] === 1,
          fenceToken: result[0] === 1 ? (result[1] ?? fenceToken) : undefined,
        };
      },
      async () => ({ acquired: false, fenceToken: undefined }),
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

  async renewLockWithFence(
    lockName: string,
    ttlMs: number,
    fenceToken: string,
    metadata?: LockMetadata,
  ): Promise<boolean> {
    const key = this.#redisClient.prefixed(`lock:${lockName}`);
    const metadataJson = this.#encodeMetadata(metadata);

    return this.#redisClient.withRedis(
      async (redis: Redis) => {
        const result = await redis.eval(
          FENCED_RENEW_SCRIPT,
          1,
          key,
          String(ttlMs),
          this.#workerId,
          fenceToken,
          metadataJson,
        );
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

  async unlockWithFence(
    lockName: string,
    fenceToken: string,
    _metadata?: LockMetadata,
  ): Promise<void> {
    const key = this.#redisClient.prefixed(`lock:${lockName}`);

    await this.#redisClient.withRedis(
      async (redis: Redis) => {
        await redis.eval(FENCED_UNLOCK_SCRIPT, 1, key, this.#workerId, fenceToken);
      },
      async () => {},
    );
  }

  async shutdown(): Promise<void> {
    await this.#redisClient.shutdown();
  }
}
