import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AuthProvider, AuthResult } from './auth-provider.js';
import type { ApiKeyRepository } from '../../db/repositories/api-key-repository.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const KEY_PREFIX_LENGTH = 8;
const KEY_BYTES = 32;

export interface GeneratedApiKey {
  fullKey: string;
  prefix: string;
  name: string;
  id: number;
}

/**
 * AuthProvider that validates API keys stored in the `api_keys` table.
 * Keys are hashed with scrypt (salt + cost parameters) before storage.
 * The full key is shown exactly once at creation time.
 */
export class DbApiKeyProvider implements AuthProvider {
  readonly name = 'DbApiKeyProvider';

  constructor(private readonly repo: ApiKeyRepository) {}

  get isActive(): boolean {
    return true;
  }

  /**
   * Generate a new API key for a tenant.
   * Returns the full key (shown once) and the persisted metadata.
   */
  async generate(input: {
    tenantId: string;
    name: string;
    role?: string;
    expiresAt?: string;
  }): Promise<GeneratedApiKey> {
    const rawKey = randomBytes(KEY_BYTES).toString('hex');
    const prefix = rawKey.slice(0, KEY_PREFIX_LENGTH);
    const hash = hashKey(rawKey);

    const stored = await this.repo.create({
      tenantId: input.tenantId,
      name: input.name,
      keyHash: hash,
      keyPrefix: prefix,
      role: input.role ?? 'admin',
      expiresAt: input.expiresAt ?? null,
    });

    logger.info({ keyName: input.name }, 'API key generated');

    return { fullKey: rawKey, prefix, name: input.name, id: stored.id };
  }

  async validate(apiKey: string): Promise<AuthResult> {
    const prefix = apiKey.slice(0, KEY_PREFIX_LENGTH);
    const stored = await this.repo.findByPrefix(prefix);
    if (!stored) {
      return { authenticated: false };
    }

    // Check expiration
    if (stored.expiresAt && new Date(stored.expiresAt) < new Date()) {
      logger.warn('Expired API key used');
      return { authenticated: false };
    }

    if (!verifyHash(stored.keyHash, apiKey)) {
      return { authenticated: false };
    }

    // Update last_used_at asynchronously (non-blocking)
    this.repo.updateLastUsed(stored.id).catch(() => {});

    return {
      authenticated: true,
      keyName: stored.name,
      tenantId: stored.tenantId,
      role: stored.role,
    };
  }
}

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLEL = 1;
const SCRYPT_KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function hashKey(key: string): string {
  const salt = randomBytes(SALT_LENGTH).toString('hex');
  const derived = scryptSync(key, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLEL,
  }).toString('hex');
  return `${salt}:${derived}`;
}

function verifyHash(stored: string, key: string): boolean {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = stored.slice(0, sep);
  const expected = stored.slice(sep + 1);
  const derived = scryptSync(key, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLEL,
  }).toString('hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(derived), Buffer.from(expected));
}
