import { describe, it, expect } from 'vitest';
import { buildAuthProvider, isMultiTenantAuth } from '../auth-factory.js';
import { EnvApiKeyProvider } from '../../providers/auth/env-api-key-provider.js';
import { DbApiKeyProvider } from '../../providers/auth/db-api-key-provider.js';
import { CompositeAuthProvider } from '../../providers/auth/composite-auth-provider.js';
import type { Config } from '../../config.js';
import type { ApiKeyRepository } from '../../db/repositories/api-key-repository.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    AUTH_PROVIDER: 'env',
    API_KEYS: undefined,
    FILE_API_KEYS: undefined,
    AUTH0_DOMAIN: undefined,
    AUTH0_AUDIENCE: undefined,
    AUTH0_JWKS_URI: undefined,
    ...overrides,
  } as Config;
}

const stubRepo = {} as ApiKeyRepository;

describe('buildAuthProvider', () => {
  it('defaults to EnvApiKeyProvider', () => {
    const provider = buildAuthProvider(baseConfig(), stubRepo);
    expect(provider).toBeInstanceOf(EnvApiKeyProvider);
  });

  it('builds DbApiKeyProvider for AUTH_PROVIDER=db', () => {
    const provider = buildAuthProvider(baseConfig({ AUTH_PROVIDER: 'db' }), stubRepo);
    expect(provider).toBeInstanceOf(DbApiKeyProvider);
  });

  it('builds a CompositeAuthProvider for AUTH_PROVIDER=auth0', () => {
    const provider = buildAuthProvider(
      baseConfig({
        AUTH_PROVIDER: 'auth0',
        AUTH0_DOMAIN: 'dominus.eu.auth0.com',
        AUTH0_AUDIENCE: 'https://api.dominus.app',
      }),
      stubRepo,
    );
    expect(provider).toBeInstanceOf(CompositeAuthProvider);
    expect((provider as CompositeAuthProvider).keyManager).toBeInstanceOf(DbApiKeyProvider);
  });

  it('fails fast for AUTH_PROVIDER=auth0 without AUTH0_DOMAIN/AUTH0_AUDIENCE', () => {
    expect(() => buildAuthProvider(baseConfig({ AUTH_PROVIDER: 'auth0' }), stubRepo)).toThrow(
      /AUTH0_DOMAIN/,
    );
  });
});

describe('isMultiTenantAuth', () => {
  it('is false for env', () => {
    expect(isMultiTenantAuth(baseConfig({ AUTH_PROVIDER: 'env' }))).toBe(false);
  });

  it('is true for db and auth0', () => {
    expect(isMultiTenantAuth(baseConfig({ AUTH_PROVIDER: 'db' }))).toBe(true);
    expect(isMultiTenantAuth(baseConfig({ AUTH_PROVIDER: 'auth0' }))).toBe(true);
  });
});
