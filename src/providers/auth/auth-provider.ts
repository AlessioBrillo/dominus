export interface AuthResult {
  authenticated: boolean;
  keyName?: string | undefined;
}

export interface AuthProvider {
  readonly name: string;
  validate(apiKey: string): Promise<AuthResult>;
}
