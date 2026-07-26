import { describe, it, expect, vi } from 'vitest';
import { CompositeAuthProvider } from '../composite-auth-provider.js';
import { DbApiKeyProvider } from '../db-api-key-provider.js';
import type { AuthProvider } from '../auth-provider.js';
import type {
  ApiKeyRepository,
  StoredApiKey,
} from '../../../db/repositories/api-key-repository.js';

function mockRepo(): ApiKeyRepository {
  const store = new Map<string, StoredApiKey>();
  return {
    create: vi.fn(async (input) => {
      const s: StoredApiKey = {
        id: store.size + 1,
        ...input,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      };
      store.set(input.keyPrefix, s);
      return s;
    }),
    findByPrefix: vi.fn(async (prefix: string) => store.get(prefix) ?? null),
    updateLastUsed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiKeyRepository;
}

function stubProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    name: 'Stub',
    isActive: true,
    supportsKeyManagement: false,
    validate: vi.fn().mockResolvedValue({ authenticated: false }),
    asKeyManager: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe('CompositeAuthProvider', () => {
  it('throws when constructed with no members', () => {
    expect(() => new CompositeAuthProvider([])).toThrow();
  });

  it('returns the first authenticated result (JWT wins over API key)', async () => {
    const jwt = stubProvider({
      validate: vi.fn().mockResolvedValue({ authenticated: true, tenantId: 'jwt-tenant' }),
    });
    const apiKey = stubProvider({
      validate: vi.fn().mockResolvedValue({ authenticated: true, tenantId: 'key-tenant' }),
    });
    const composite = new CompositeAuthProvider([jwt, apiKey]);

    const result = await composite.validate('token');

    expect(result).toEqual({ authenticated: true, tenantId: 'jwt-tenant' });
    expect(apiKey.validate).not.toHaveBeenCalled();
  });

  it('falls back to the next provider when the first fails', async () => {
    const jwt = stubProvider();
    const apiKey = stubProvider({
      validate: vi.fn().mockResolvedValue({ authenticated: true, tenantId: 'key-tenant' }),
    });
    const composite = new CompositeAuthProvider([jwt, apiKey]);

    const result = await composite.validate('token');

    expect(result.authenticated).toBe(true);
    expect(result.tenantId).toBe('key-tenant');
  });

  it('returns unauthenticated when every member fails', async () => {
    const composite = new CompositeAuthProvider([stubProvider(), stubProvider()]);
    const result = await composite.validate('token');
    expect(result).toEqual({ authenticated: false });
  });

  it('isActive is true when at least one member is active', () => {
    const composite = new CompositeAuthProvider([
      stubProvider({ isActive: false }),
      stubProvider({ isActive: true }),
    ]);
    expect(composite.isActive).toBe(true);
  });

  it('supportsKeyManagement is true when at least one member supports it', () => {
    const composite = new CompositeAuthProvider([
      stubProvider({ supportsKeyManagement: false }),
      new DbApiKeyProvider(mockRepo()),
    ]);
    expect(composite.supportsKeyManagement).toBe(true);
  });

  it('exposes the DbApiKeyProvider member as keyManager', () => {
    const dbProvider = new DbApiKeyProvider(mockRepo());
    const composite = new CompositeAuthProvider([stubProvider(), dbProvider]);
    expect(composite.asKeyManager()).toBe(dbProvider);
  });

  it('keyManager is undefined when no member is a DbApiKeyProvider', () => {
    const composite = new CompositeAuthProvider([stubProvider(), stubProvider()]);
    expect(composite.asKeyManager()).toBeUndefined();
  });
});
