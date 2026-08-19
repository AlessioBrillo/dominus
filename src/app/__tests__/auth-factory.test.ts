// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  buildAuthProvider,
  buildOidcDeps,
  buildSessionJwt,
  isMultiTenantAuth,
  isUsageEnforcementActive,
} from '../auth-factory.js';
import { EnvApiKeyProvider } from '../../providers/auth/env-api-key-provider.js';
import { DbApiKeyProvider } from '../../providers/auth/db-api-key-provider.js';
import { CompositeAuthProvider } from '../../providers/auth/composite-auth-provider.js';
import { Auth0OidcProvider } from '../../providers/auth/oidc-provider.js';
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
    expect((provider as CompositeAuthProvider).asKeyManager()).toBeInstanceOf(DbApiKeyProvider);
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

describe('isUsageEnforcementActive', () => {
  it('is opt-in on the community edition (env keys)', () => {
    expect(isUsageEnforcementActive(baseConfig({ AUTH_PROVIDER: 'env' }))).toBe(false);
    expect(
      isUsageEnforcementActive(
        baseConfig({ AUTH_PROVIDER: 'env', USAGE_ENFORCEMENT_ENABLED: true }),
      ),
    ).toBe(true);
  });

  it('is fail-closed for managed identity even without the env flag', () => {
    expect(isUsageEnforcementActive(baseConfig({ AUTH_PROVIDER: 'db' }))).toBe(true);
    expect(isUsageEnforcementActive(baseConfig({ AUTH_PROVIDER: 'auth0' }))).toBe(true);
  });
});

const OIDC_BASE = {
  AUTH_PROVIDER: 'auth0' as const,
  AUTH0_DOMAIN: 'dominus.eu.auth0.com',
  AUTH0_AUDIENCE: 'https://api.dominus.app',
  AUTH0_CLIENT_ID: 'client-123',
  AUTH0_CLIENT_SECRET: 'secret-456',
  AUTH0_CALLBACK_URL: 'https://dominus.app/api/v1/auth/oidc/callback',
  AUTH0_SESSION_TTL_HOURS: 8,
};

describe('buildOidcDeps (ADR-0062)', () => {
  it('returns undefined for the community edition', () => {
    expect(buildOidcDeps(baseConfig({ AUTH_PROVIDER: 'env' }))).toBeUndefined();
  });

  it('returns undefined when auth0 client credentials are missing (fail-closed)', () => {
    expect(
      buildOidcDeps(
        baseConfig({
          AUTH_PROVIDER: 'auth0',
          AUTH0_DOMAIN: 'dominus.eu.auth0.com',
          AUTH0_AUDIENCE: 'https://api.dominus.app',
        }),
      ),
    ).toBeUndefined();
    expect(
      buildOidcDeps(
        baseConfig({
          ...OIDC_BASE,
          AUTH0_CLIENT_SECRET: undefined,
        }),
      ),
    ).toBeUndefined();
    expect(
      buildOidcDeps(
        baseConfig({
          ...OIDC_BASE,
          AUTH0_CALLBACK_URL: undefined,
        }),
      ),
    ).toBeUndefined();
  });

  it('throws when auth0 mode with OIDC credentials lacks domain/audience', () => {
    expect(() =>
      buildOidcDeps(
        baseConfig({
          AUTH_PROVIDER: 'auth0',
          AUTH0_CLIENT_ID: 'client-123',
          AUTH0_CLIENT_SECRET: 'secret-456',
          AUTH0_CALLBACK_URL: 'https://dominus.app/api/v1/auth/oidc/callback',
        }),
      ),
    ).toThrow(/AUTH0_DOMAIN/);
  });

  it('builds an Auth0OidcProvider with the callback URL', () => {
    const deps = buildOidcDeps(baseConfig(OIDC_BASE));
    expect(deps).toBeDefined();
    expect(deps?.provider).toBeInstanceOf(Auth0OidcProvider);
    expect(deps?.callbackUrl).toBe('https://dominus.app/api/v1/auth/oidc/callback');
    expect(deps?.sessionTtlMs).toBe(8 * 60 * 60 * 1000);
  });

  it('honours AUTH0_SESSION_TTL_HOURS', () => {
    const deps = buildOidcDeps(baseConfig({ ...OIDC_BASE, AUTH0_SESSION_TTL_HOURS: 2 }));
    expect(deps?.sessionTtlMs).toBe(2 * 60 * 60 * 1000);
  });
});

describe('buildSessionJwt', () => {
  it('mints and verifies a session round-trip', async () => {
    const sessionJwt = buildSessionJwt(baseConfig(OIDC_BASE));
    const token = await sessionJwt.mint({ sub: 'user-1', tenantId: 'org-42' });
    await expect(sessionJwt.verify(token)).resolves.toEqual({
      sub: 'user-1',
      tenantId: 'org-42',
    });
  });
});
