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
}
