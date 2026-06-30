import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthProvider, AuthResult } from './auth-provider.js';

export interface Auth0Config {
  domain: string;
  audience: string;
  jwksUri?: string;
}

const JWKS_CACHE_TTL_MS = 300_000;

export class Auth0Provider implements AuthProvider {
  readonly name = 'Auth0Provider';
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #expectedIssuer: string;
  readonly #expectedAudience: string;
  readonly #active: boolean;

  constructor(config: Auth0Config) {
    this.#expectedIssuer = `https://${config.domain}/`;
    this.#expectedAudience = config.audience;
    const jwksUrl = new URL(config.jwksUri ?? `https://${config.domain}/.well-known/jwks.json`);
    this.#jwks = createRemoteJWKSet(jwksUrl, {
      cacheMaxAge: JWKS_CACHE_TTL_MS,
      cooldownDuration: 30_000,
    });
    this.#active = true;
  }

  get isActive(): boolean {
    return this.#active;
  }

  async validate(token: string): Promise<AuthResult> {
    if (!token || !this.#active) {
      return { authenticated: false };
    }

    try {
      const { payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.#expectedIssuer,
        audience: this.#expectedAudience,
      });

      return {
        authenticated: true,
        userId: payload.sub,
        tenantId: payload.org_id as string | undefined,
        role: payload.role as string | undefined,
        keyName: payload.sub,
      };
    } catch {
      return { authenticated: false };
    }
  }
}
