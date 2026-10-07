// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthResult } from './auth-provider.js';

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
