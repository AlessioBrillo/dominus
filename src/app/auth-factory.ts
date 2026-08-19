// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../config.js';
import type { AuthProvider } from '../providers/auth/auth-provider.js';
import type { OidcProvider } from '../providers/auth/oidc-provider.js';
import type { ApiKeyRepository } from '../db/repositories/api-key-repository.js';
import { EnvApiKeyProvider } from '../providers/auth/env-api-key-provider.js';
import { DbApiKeyProvider } from '../providers/auth/db-api-key-provider.js';
import { Auth0Provider } from '../providers/auth/auth0-provider.js';
import { Auth0OidcProvider } from '../providers/auth/oidc-provider.js';
import { CompositeAuthProvider } from '../providers/auth/composite-auth-provider.js';
import { createSessionJwtMinter } from '../providers/auth/session-jwt.js';

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

/**
 * Builds the interactive SSO login flow (OIDC Authorization Code + PKCE,
 * ADR-0062). Returns undefined unless AUTH_PROVIDER=auth0 AND the full
 * client-credential triple is configured. The bearer-token validation path
 * (AUTH0_DOMAIN/AUDIENCE) works independently — the SSO endpoints are an
 * additive layer, fail-closed when not configured.
 */
export function buildOidcDeps(config: Config):
  | {
      provider: OidcProvider;
      clientSecret: string;
      callbackUrl: string;
      sessionTtlMs: number;
    }
  | undefined {
  if (config.AUTH_PROVIDER !== 'auth0') return undefined;
  if (!config.AUTH0_CLIENT_ID || !config.AUTH0_CLIENT_SECRET || !config.AUTH0_CALLBACK_URL) {
    return undefined;
  }
  if (!config.AUTH0_DOMAIN || !config.AUTH0_AUDIENCE) {
    throw new Error(
      'AUTH_PROVIDER=auth0 with OIDC credentials requires AUTH0_DOMAIN and AUTH0_AUDIENCE',
    );
  }
  const tokenValidator = new Auth0Provider({
    domain: config.AUTH0_DOMAIN,
    audience: config.AUTH0_AUDIENCE,
    ...(config.AUTH0_JWKS_URI ? { jwksUri: config.AUTH0_JWKS_URI } : {}),
  });
  const provider = new Auth0OidcProvider({
    domain: config.AUTH0_DOMAIN,
    clientId: config.AUTH0_CLIENT_ID,
    clientSecret: config.AUTH0_CLIENT_SECRET,
    callbackUrl: config.AUTH0_CALLBACK_URL,
    tokenValidator,
  });
  return {
    provider,
    clientSecret: config.AUTH0_CLIENT_SECRET,
    callbackUrl: config.AUTH0_CALLBACK_URL,
    sessionTtlMs: config.AUTH0_SESSION_TTL_HOURS * 60 * 60 * 1000,
  };
}

/** Session cookie JWT minter + verifier for the SSO flow (ADR-0062). Keys are
 *  HKDF-derived from AUTH0_CLIENT_SECRET — no separate secret to manage. */
export function buildSessionJwt(config: Config): ReturnType<typeof createSessionJwtMinter> {
  return createSessionJwtMinter(config.AUTH0_CLIENT_SECRET ?? '', config.AUTH0_SESSION_TTL_HOURS);
}

/**
 * Whether plan usage enforcement is active at the chokepoints. Fail-closed
 * in managed (Cloud) mode: identity db/auth0 implies billing, so metering
 * is forced on even if the operator forgets USAGE_ENFORCEMENT_ENABLED — a
 * Cloud deploy must never charge for plans while metering nothing
 * (ADR-0038). The community edition (env keys, single user) stays opt-in.
 */
export function isUsageEnforcementActive(config: Config): boolean {
  return config.USAGE_ENFORCEMENT_ENABLED || isMultiTenantAuth(config);
}
