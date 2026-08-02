// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../config.js';
import type { AuthProvider } from '../providers/auth/auth-provider.js';
import type { ApiKeyRepository } from '../db/repositories/api-key-repository.js';
import { EnvApiKeyProvider } from '../providers/auth/env-api-key-provider.js';
import { DbApiKeyProvider } from '../providers/auth/db-api-key-provider.js';
import { Auth0Provider } from '../providers/auth/auth0-provider.js';
import { CompositeAuthProvider } from '../providers/auth/composite-auth-provider.js';

/**
 * Selects the AuthProvider implementation from `config.AUTH_PROVIDER`.
 * - 'env': static API keys (community edition, default)
 * - 'db': per-tenant API keys stored in the database (DOMINUS Cloud, CLI-only)
 * - 'auth0': browser JWT (Auth0) with API key fallback for the CLI (DOMINUS Cloud)
 * See ADR-0032.
 */
export function buildAuthProvider(config: Config, apiKeyRepo: ApiKeyRepository): AuthProvider {
  switch (config.AUTH_PROVIDER) {
    case 'db':
      return new DbApiKeyProvider(apiKeyRepo);

    case 'auth0': {
      if (!config.AUTH0_DOMAIN || !config.AUTH0_AUDIENCE) {
        throw new Error(
          'AUTH_PROVIDER=auth0 requires AUTH0_DOMAIN and AUTH0_AUDIENCE to be configured',
        );
      }
      const auth0Provider = new Auth0Provider({
        domain: config.AUTH0_DOMAIN,
        audience: config.AUTH0_AUDIENCE,
        ...(config.AUTH0_JWKS_URI ? { jwksUri: config.AUTH0_JWKS_URI } : {}),
      });
      return new CompositeAuthProvider([auth0Provider, new DbApiKeyProvider(apiKeyRepo)]);
    }

    case 'env':
    default:
      return new EnvApiKeyProvider(config.API_KEYS, config.FILE_API_KEYS);
  }
}

/** True for any Cloud auth mode (db or auth0) where a missing tenant on an
 *  authenticated request must be rejected rather than defaulted. */
export function isMultiTenantAuth(config: Config): boolean {
  return config.AUTH_PROVIDER !== 'env';
}
