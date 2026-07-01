import { describe, it, expect, vi } from 'vitest';
import { DbApiKeyProvider } from '../db-api-key-provider.js';
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
    findByPrefix: vi.fn(async (prefix) => store.get(prefix) ?? null),
    updateLastUsed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiKeyRepository;
}

describe('DbApiKeyProvider', () => {
  it('generate returns fullKey, prefix, name, and id', async () => {
    const p = new DbApiKeyProvider(mockRepo());
    const r = await p.generate({ tenantId: 'default', name: 'k', role: 'admin' });
    expect(r.fullKey).toBeTruthy();
    expect(r.prefix).toBe(r.fullKey.slice(0, 8));
    expect(r.name).toBe('k');
    expect(r.id).toBe(1);
  });

  it('validate succeeds for a generated key', async () => {
    const p = new DbApiKeyProvider(mockRepo());
    const { fullKey } = await p.generate({ tenantId: 't', name: 'k' });
    const r = await p.validate(fullKey);
    expect(r.authenticated).toBe(true);
    expect(r.keyName).toBe('k');
    expect(r.tenantId).toBe('t');
  });

  it('validate fails for unknown key', async () => {
    const r = await new DbApiKeyProvider(mockRepo()).validate('unknown');
    expect(r.authenticated).toBe(false);
  });

  it('validate fails for expired key', async () => {
    const p = new DbApiKeyProvider(mockRepo());
    const { fullKey } = await p.generate({ tenantId: 't', name: 'x', expiresAt: '2020-01-01' });
    expect((await p.validate(fullKey)).authenticated).toBe(false);
  });
});
