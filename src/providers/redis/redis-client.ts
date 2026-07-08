import { Redis, type RedisOptions } from 'ioredis';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface RedisClientConfig {
  url: string;
  tlsEnabled?: boolean;
  keyPrefix?: string;
  maxRetries?: number;
  retryBaseMs?: number;
}

export interface RedisHealth {
  ok: boolean;
  latencyMs: number | null;
}

const DEFAULT_CONFIG: Required<RedisClientConfig> & { retryBaseMs: number } = {
  url: '',
  tlsEnabled: false,
  keyPrefix: 'dominus:',
  maxRetries: 10,
  retryBaseMs: 200,
};

export class RedisClient {
  readonly #redis: Redis | null = null;
  readonly #config: Required<RedisClientConfig>;
  readonly #keyPrefix: string;
  #healthy = false;

  constructor(config: RedisClientConfig) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#keyPrefix = this.#config.keyPrefix;

    if (!this.#config.url) {
      logger.warn('No REDIS_URL configured — Redis client disabled');
      this.#redis = null;
      return;
    }

    const options: RedisOptions = {
      lazyConnect: true,
      enableAutoPipelining: false,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => {
        if (times > this.#config.maxRetries) {
          logger.error(
            { maxRetries: this.#config.maxRetries },
            'Redis connection retry limit reached — disabling Redis',
          );
          this.#healthy = false;
          return null;
        }
        const delay = Math.min(this.#config.retryBaseMs * Math.pow(2, times - 1), 30_000);
        return delay;
      },
      ...(this.#config.tlsEnabled ? { tls: {} } : {}),
    };

    this.#redis = new Redis(this.#config.url, options);

    this.#redis.on('connect', () => {
      logger.info({ keyPrefix: this.#keyPrefix }, 'Redis connected');
    });

    this.#redis.on('ready', () => {
      this.#healthy = true;
      logger.info('Redis ready');
    });

    this.#redis.on('close', () => {
      this.#healthy = false;
      logger.warn('Redis connection closed');
    });

    this.#redis.on('error', (err) => {
      this.#healthy = false;
      logger.error({ err: err.message }, 'Redis error');
    });

    this.#redis.on('reconnecting', (delayMs: number) => {
      logger.info({ delayMs }, 'Redis reconnecting');
    });

    this.#redis.connect().catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Redis initial connection failed — running in degraded mode',
      );
      this.#healthy = false;
    });
  }

  get client(): Redis | null {
    return this.#redis;
  }

  get isConnected(): boolean {
    return this.#healthy && this.#redis !== null && this.#redis.status === 'ready';
  }

  get keyPrefix(): string {
    return this.#keyPrefix;
  }

  prefixed(key: string): string {
    return `${this.#keyPrefix}${key}`;
  }

  async ping(): Promise<RedisHealth> {
    if (!this.#redis) return { ok: false, latencyMs: null };

    try {
      const start = Date.now();
      await this.#redis.ping();
      const latencyMs = Date.now() - start;
      this.#healthy = true;
      return { ok: true, latencyMs };
    } catch {
      this.#healthy = false;
      return { ok: false, latencyMs: null };
    }
  }

  /** Graceful shutdown: close Redis connection, wait for drain. */
  async shutdown(): Promise<void> {
    if (!this.#redis) return;
    try {
      await this.#redis.quit();
      this.#healthy = false;
      logger.info('Redis client shut down gracefully');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Redis shutdown error',
      );
      this.#redis.disconnect();
      this.#healthy = false;
    }
  }

  /** Execute fn() with the Redis client, falling back to fallback() on any error. */
  async withRedis<T>(fn: (redis: Redis) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (!this.#redis || !this.isConnected) {
      return fallback();
    }
    try {
      return await fn(this.#redis);
    } catch (err) {
      this.#healthy = false;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Redis operation failed — falling back',
      );
      return fallback();
    }
  }
}

let _instance: RedisClient | null = null;

export function getRedisClient(config?: RedisClientConfig): RedisClient {
  if (_instance) return _instance;
  if (!config) {
    _instance = new RedisClient({ url: '' });
    return _instance;
  }
  _instance = new RedisClient(config);
  return _instance;
}

export function resetRedisClient(): void {
  if (_instance) {
    _instance.shutdown().catch(() => {});
    _instance = null;
  }
}
