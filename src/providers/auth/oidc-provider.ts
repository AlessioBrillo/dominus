// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthProvider, AuthResult } from './auth-provider.js';

export interface OidcAuthorizeInput {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface OidcTokenResult {
  accessToken: string;
  idToken: string;
  expiresIn: number;
}

/**
 * Interactive SSO login flow (OIDC Authorization Code + PKCE, ADR-0062).
 * Separate from AuthProvider (bearer-token validation) so the routes depend
 * on this narrow interface, not on any specific IdP implementation.
 */
export interface OidcProvider {
  readonly isEnabled: boolean;
  buildAuthorizeUrl(input: OidcAuthorizeInput): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OidcTokenResult>;
  validateIdToken(idToken: string): Promise<AuthResult>;
  logoutUrl(redirectUri: string): string;
}

export interface Auth0OidcConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  /** Validates the ID token against the Auth0 JWKS (issuer + audience). */
  tokenValidator: AuthProvider;
  scope?: string;
  timeoutMs?: number;
}

const DEFAULT_SCOPE = 'openid profile email';
const DEFAULT_TIMEOUT_MS = 10_000;

export class Auth0OidcProvider implements OidcProvider {
  readonly name = 'Auth0OidcProvider';
  readonly #config: {
    domain: string;
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    scope: string;
    timeoutMs: number;
  };
  readonly #tokenValidator: AuthProvider;

  constructor(config: Auth0OidcConfig) {
    this.#config = {
      domain: config.domain,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      callbackUrl: config.callbackUrl,
      scope: config.scope ?? DEFAULT_SCOPE,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.#tokenValidator = config.tokenValidator;
  }

  get isEnabled(): boolean {
    return true;
  }

  buildAuthorizeUrl(input: OidcAuthorizeInput): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.#config.clientId,
      redirect_uri: input.redirectUri,
      scope: this.#config.scope,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://${this.#config.domain}/authorize?${params.toString()}`;
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OidcTokenResult> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });

    const response = await fetch(`https://${this.#config.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(this.#config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Auth0 token exchange failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      access_token?: string;
      id_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (payload.error || !payload.access_token || !payload.id_token) {
      throw new Error(`Auth0 token exchange rejected: ${payload.error ?? 'missing tokens'}`);
    }

    return {
      accessToken: payload.access_token,
      idToken: payload.id_token,
      expiresIn: payload.expires_in ?? 3600,
    };
  }

  validateIdToken(idToken: string): Promise<AuthResult> {
    return this.#tokenValidator.validate(idToken);
  }

  logoutUrl(redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.#config.clientId,
      returnTo: redirectUri,
    });
    return `https://${this.#config.domain}/v2/logout?${params.toString()}`;
  }
}
