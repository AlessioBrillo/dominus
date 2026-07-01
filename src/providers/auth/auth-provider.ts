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
  validate(apiKey: string): Promise<AuthResult>;
}
