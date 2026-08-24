// SPDX-License-Identifier: AGPL-3.0-only
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
  readonly #lockOwners: Map<string, string> = new Map();

  constructor(providers: NamedLockProvider[], redisClient?: RedisClient) {
    this.#providers = providers;
    this.#redisClient = redisClient ?? null;
    logger.info({ providers: providers.map((p) => p.name) }, 'CompositeLockProvider initialized');
  }

  #findProvider(name: string): NamedLockProvider | undefined {
    return this.#providers.find((p) => p.name === name);
  }

  #getStartIndex(): number {
    if (this.#redisClient && !this.#redisClient.isConnected && this.#providers.length > 1) {
      const redisName = this.#providers[0]?.name ?? '';
      if (redisName.startsWith('Redis')) {
        logger.warn('Redis not connected — starting with database lock provider');
        return 1;
      }
    }
    return 0;
  }

  async tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    const startIndex = this.#getStartIndex();

    for (let i = startIndex; i < this.#providers.length; i++) {
      const { name, provider } = this.#providers[i]!;
      try {
        const result = await provider.tryLock(lockName, ttlMs);
        if (result) {
          this.#lockOwners.set(lockName, name);
          logger.debug({ lockName, provider: name }, 'CompositeLockProvider: lock acquired');
          return true;
        }
        logger.warn(
          { lockName, provider: name },
          'CompositeLockProvider: lock refused (contended)',
        );
      } catch (err) {
        logger.error({ err, lockName, provider: name }, 'CompositeLockProvider: provider error');
      }
    }

    logger.error(
      { lockName, attempted: this.#providers.slice(startIndex).map((p) => p.name) },
      'CompositeLockProvider: all providers failed to acquire lock',
    );
    return false;
  }

  async renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    const ownerName = this.#lockOwners.get(lockName);
    if (!ownerName) {
      logger.warn({ lockName }, 'CompositeLockProvider: renew called on unknown lock');
      return false;
    }

    const named = this.#findProvider(ownerName);
    if (!named) {
      logger.error({ lockName, ownerName }, 'CompositeLockProvider: lock owner provider not found');
      this.#lockOwners.delete(lockName);
      return false;
    }

    try {
      return await named.provider.renewLock(lockName, ttlMs);
    } catch (err) {
      logger.error({ err, lockName, provider: ownerName }, 'CompositeLockProvider: renew failed');
      return false;
    }
  }

  async unlock(lockName: string): Promise<void> {
    const ownerName = this.#lockOwners.get(lockName);
    if (!ownerName) {
      logger.warn({ lockName }, 'CompositeLockProvider: unlock called on unknown lock');
      return;
    }

    const named = this.#findProvider(ownerName);
    if (named) {
      try {
        await named.provider.unlock(lockName);
      } catch (err) {
        logger.error(
          { err, lockName, provider: ownerName },
          'CompositeLockProvider: unlock failed',
        );
      }
    }

    this.#lockOwners.delete(lockName);
  }

  async tryLockWithFence(
    lockName: string,
    ttlMs: number,
  ): Promise<{ acquired: boolean; fenceToken: string | undefined }> {
    const startIndex = this.#getStartIndex();

    for (let i = startIndex; i < this.#providers.length; i++) {
      const { name, provider } = this.#providers[i]!;
      try {
        const result = await provider.tryLockWithFence(lockName, ttlMs);
        if (result.acquired) {
          this.#lockOwners.set(lockName, name);
          // Store fence token with lock name for renew/unlock
          this.#lockOwners.set(`${lockName}:fence`, result.fenceToken ?? '');
          logger.debug({ lockName, provider: name }, 'CompositeLockProvider: fenced lock acquired');
          return result;
        }
        logger.warn(
          { lockName, provider: name },
          'CompositeLockProvider: fenced lock refused (contended)',
        );
      } catch (err) {
        logger.error({ err, lockName, provider: name }, 'CompositeLockProvider: provider error');
      }
    }

    logger.error(
      { lockName, attempted: this.#providers.slice(startIndex).map((p) => p.name) },
      'CompositeLockProvider: all providers failed to acquire fenced lock',
    );
    return { acquired: false, fenceToken: undefined };
  }

  async renewLockWithFence(lockName: string, ttlMs: number, fenceToken: string): Promise<boolean> {
    const ownerName = this.#lockOwners.get(lockName);
    if (!ownerName) {
      logger.warn({ lockName }, 'CompositeLockProvider: renew called on unknown lock');
      return false;
    }

    const named = this.#findProvider(ownerName);
    if (!named) {
      logger.error({ lockName, ownerName }, 'CompositeLockProvider: lock owner provider not found');
      this.#lockOwners.delete(lockName);
      return false;
    }

    try {
      return await named.provider.renewLockWithFence(lockName, ttlMs, fenceToken);
    } catch (err) {
      logger.error({ err, lockName, provider: ownerName }, 'CompositeLockProvider: renew failed');
      return false;
    }
  }

  async unlockWithFence(lockName: string, fenceToken: string): Promise<void> {
    const ownerName = this.#lockOwners.get(lockName);
    if (!ownerName) {
      logger.warn({ lockName }, 'CompositeLockProvider: unlock called on unknown lock');
      return;
    }

    const named = this.#findProvider(ownerName);
    if (named) {
      try {
        await named.provider.unlockWithFence(lockName, fenceToken);
      } catch (err) {
        logger.error(
          { err, lockName, provider: ownerName },
          'CompositeLockProvider: unlock failed',
        );
      }
    }

    this.#lockOwners.delete(lockName);
    this.#lockOwners.delete(`${lockName}:fence`);
  }

  clearLockOwners(): void {
    this.#lockOwners.clear();
  }
}
