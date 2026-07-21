import type { RedisClient } from './redis-client.js';
import type { LockProvider } from '../../types/lock.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface NamedLockProvider {
  name: string;
  provider: LockProvider;
}

export class CompositeLockProvider implements LockProvider {
  readonly #providers: NamedLockProvider[];
  readonly #redisClient: RedisClient | null;
  #activeIndex: number = 0;

  constructor(providers: NamedLockProvider[], redisClient?: RedisClient) {
    this.#providers = providers;
    this.#redisClient = redisClient ?? null;
    logger.info({ providers: providers.map((p) => p.name) }, 'CompositeLockProvider initialized');
  }

  #active(): NamedLockProvider {
    return this.#providers[this.#activeIndex]!;
  }

  async tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    if (this.#redisClient && !this.#redisClient.isConnected && this.#activeIndex === 0) {
      logger.warn({ lockName }, 'Redis not connected — falling back to database lock provider');
      this.#activeIndex = 1;
    }

    for (
      let i = this.#activeIndex;
      i < Math.min(this.#activeIndex + 1, this.#providers.length);
      i++
    ) {
      const { name, provider } = this.#providers[i]!;
      try {
        const result = await provider.tryLock(lockName, ttlMs);
        if (!result && name.startsWith('Redis') && i < this.#providers.length - 1) {
          logger.warn(
            { lockName, provider: name },
            'Redis lock provider returned false — falling back to database lock',
          );
          this.#activeIndex = i + 1;
          return this.#providers[this.#activeIndex]!.provider.tryLock(lockName, ttlMs);
        }
        return result;
      } catch (err) {
        logger.error({ err, lockName, provider: name }, 'CompositeLockProvider: provider error');
        if (i < this.#providers.length - 1) {
          this.#activeIndex = i + 1;
          logger.warn(
            { lockName, fallbackProvider: this.#providers[this.#activeIndex]!.name },
            'CompositeLockProvider: switching to fallback',
          );
          return this.#providers[this.#activeIndex]!.provider.tryLock(lockName, ttlMs);
        }
        return false;
      }
    }
    return false;
  }

  async renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    const { name, provider } = this.#active();
    try {
      return await provider.renewLock(lockName, ttlMs);
    } catch (err) {
      logger.error({ err, lockName, provider: name }, 'CompositeLockProvider: renew failed');
      return false;
    }
  }

  async unlock(lockName: string): Promise<void> {
    const { name, provider } = this.#active();
    try {
      await provider.unlock(lockName);
    } catch (err) {
      logger.error({ err, lockName, provider: name }, 'CompositeLockProvider: unlock failed');
    }
  }
}
