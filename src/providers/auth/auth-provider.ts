// SPDX-License-Identifier: AGPL-3.0-only
export interface AuthResult {
  authenticated: boolean;
  keyName?: string | undefined;
  userId?: string | undefined;
  tenantId?: string | undefined;
  role?: string | undefined;
}

export interface AuthProvider {
  readonly name: string;
  readonly isActive: boolean;
  /** Whether this provider supports API key CRUD operations (generate, list, revoke).
   *  When true, the auth router exposes /api-keys management endpoints.
   *  Community edition (EnvApiKeyProvider) returns false; Cloud (DbApiKeyProvider) returns true. */
  readonly supportsKeyManagement: boolean;
  validate(apiKey: string): Promise<AuthResult>;
  /** Returns a provider capable of key CRUD if this provider supports it,
   *  or undefined otherwise. Replaces brittle `instanceof` checks in composite
   *  providers — the contract is explicit on the interface rather than relying
   *  on class identity. */
  asKeyManager(): KeyManager | undefined;
}

export interface GeneratedKeyResult {
  fullKey: string;
  prefix: string;
  name: string;
  id: number;
}

/** Provider that can generate, list, and revoke API keys.
 *  Extends AuthProvider to guarantee validate() is available. */
export interface KeyManager extends AuthProvider {
  generate(input: {
    tenantId: string;
    name: string;
    role?: string;
    expiresAt?: string;
  }): Promise<GeneratedKeyResult>;
}
