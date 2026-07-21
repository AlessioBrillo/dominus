import type { Redis } from 'ioredis';
import type { RedisClient } from './redis-client.js';
import { getRedisClient } from './redis-client.js';
import type { ICircuitBreaker, CircuitState, CircuitBreakerPolicy } from '../circuit-breaker.js';

const DEFAULT_POLICY: CircuitBreakerPolicy = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 120_000,
};

const LUA_RECORD_FAILURE = `
  local key = KEYS[1]
  local window = tonumber(ARGV[1])
  local threshold = tonumber(ARGV[2])
  local cooldown = tonumber(ARGV[3])
  local now = redis.call('TIME')[1]

  local state = redis.call('hget', key, 'state')
  if state == 'open' then
    local openedAt = tonumber(redis.call('hget', key, 'openedAt') or '0')
    if openedAt > 0 and (now - openedAt) >= math.ceil(cooldown / 1000) then
      redis.call('hset', key, 'state', 'half-open')
      redis.call('hset', key, 'openedAt', '0')
      redis.call('expire', key, math.ceil(cooldown / 1000))
      return 'half-open'
    end
    return 'open'
  end

  if state == 'half-open' then
    redis.call('hset', key, 'state', 'open')
    redis.call('hset', key, 'openedAt', now)
    redis.call('expire', key, math.ceil(cooldown / 1000))
    return 'open'
  end

  local count = redis.call('incr', key .. ':failures')
  if count == 1 then
    redis.call('expire', key .. ':failures', math.ceil(window / 1000))
  end

  if count >= threshold then
    redis.call('hset', key, 'state', 'open')
    redis.call('hset', key, 'openedAt', now)
    redis.call('expire', key, math.ceil(cooldown / 1000))
    redis.call('del', key .. ':failures')
    return 'open'
  end

  return 'closed'
`;

const LUA_RECORD_SUCCESS = `
  local key = KEYS[1]
  local state = redis.call('hget', key, 'state')
  if state == 'half-open' then
    redis.call('hset', key, 'state', 'closed')
    redis.call('del', key .. ':failures')
    redis.call('expire', key, math.ceil(tonumber(ARGV[1]) / 1000))
    return 'closed'
  end
  if state == 'closed' or state == false then
    redis.call('del', key .. ':failures')
    return 'closed'
  end
  return state
`;

const LUA_ALLOW = `
  local key = KEYS[1]
  local state = redis.call('hget', key, 'state')
  local now = redis.call('TIME')[1]
  local cooldown = tonumber(ARGV[1])

  if state == 'open' then
    local openedAt = tonumber(redis.call('hget', key, 'openedAt') or '0')
    if openedAt > 0 and (now - openedAt) >= math.ceil(cooldown / 1000) then
      redis.call('hset', key, 'state', 'half-open')
      redis.call('hset', key, 'openedAt', '0')
      redis.call('expire', key, math.ceil(cooldown / 1000))
      return 1
    end
    return 0
  end

  if state == 'half-open' then
    return 1
  end

  return 1
`;

export { CircuitBreakerPolicy };

export class DistributedCircuitBreaker implements ICircuitBreaker {
  readonly #redisClient: RedisClient;
  readonly #policy: CircuitBreakerPolicy;
  readonly #keyPrefix: string;

  /**
   * In-memory cache of the current circuit state to avoid a Redis
   * round-trip on every allow() call. State transitions are committed
   * to Redis atomically via Lua scripts.
   */
  #cachedState: CircuitState = 'closed';
  #cachedAt: number = 0;
  static readonly CACHE_TTL_MS = 2_000;

  constructor(name: string, policy: Partial<CircuitBreakerPolicy> = {}, redisClient?: RedisClient) {
    this.#redisClient = redisClient ?? getRedisClient();
    this.#policy = { ...DEFAULT_POLICY, ...policy };
    this.#keyPrefix = this.#redisClient.prefixed(`cb:${name}`);
  }

  get cooldownMs(): number {
    return this.#policy.cooldownMs;
  }

  get state(): CircuitState {
    return this.#cachedState;
  }

  #isCacheValid(): boolean {
    return Date.now() - this.#cachedAt < DistributedCircuitBreaker.CACHE_TTL_MS;
  }

  async allow(): Promise<boolean> {
    if (this.#isCacheValid() && this.#cachedState === 'closed') return true;

    return this.#redisClient.withRedis(
      async (redis: Redis) => {
        const result = await redis.eval(
          LUA_ALLOW,
          1,
          this.#keyPrefix,
          String(this.#policy.cooldownMs),
        );
        const allowed = result === 1;
        if (this.#cachedState !== 'closed' || !this.#isCacheValid()) {
          const state = await this.#fetchState(redis);
          this.#cachedState = state;
          this.#cachedAt = Date.now();
        }
        return allowed;
      },
      async () => true,
    );
  }

  async onSuccess(): Promise<void> {
    this.#cachedState = 'closed';
    this.#cachedAt = Date.now();

    await this.#redisClient.withRedis(
      async (redis: Redis) => {
        await redis.eval(LUA_RECORD_SUCCESS, 1, this.#keyPrefix, String(this.#policy.windowMs));
      },
      async () => {},
    );
  }

  async onFailure(): Promise<void> {
    this.#cachedAt = 0;

    const state = await this.#redisClient.withRedis(
      async (redis: Redis) => {
        const result = await redis.eval(
          LUA_RECORD_FAILURE,
          1,
          this.#keyPrefix,
          String(this.#policy.windowMs),
          String(this.#policy.failureThreshold),
          String(this.#policy.cooldownMs),
        );
        return result as CircuitState;
      },
      async () => 'closed' as CircuitState,
    );

    this.#cachedState = state;
    this.#cachedAt = Date.now();
  }

  async #fetchState(redis: Redis): Promise<CircuitState> {
    const state = await redis.hget(this.#keyPrefix, 'state');
    return (state as CircuitState) ?? 'closed';
  }

  async forceOpen(): Promise<void> {
    this.#cachedState = 'open';
    this.#cachedAt = Date.now();

    await this.#redisClient.withRedis(
      async (redis: Redis) => {
        await redis
          .multi()
          .hset(this.#keyPrefix, 'state', 'open')
          .hset(this.#keyPrefix, 'openedAt', String(Math.floor(Date.now() / 1000)))
          .expire(this.#keyPrefix, Math.ceil(this.#policy.cooldownMs / 1000))
          .exec();
      },
      async () => {},
    );
  }

  async forceClosed(): Promise<void> {
    this.#cachedState = 'closed';
    this.#cachedAt = Date.now();

    await this.#redisClient.withRedis(
      async (redis: Redis) => {
        await redis.del(this.#keyPrefix);
      },
      async () => {},
    );
  }

  reset(): void {
    this.#cachedState = 'closed';
    this.#cachedAt = 0;
    this.forceClosed().catch(() => {});
  }
}
