import type { AuthProvider, AuthResult } from './auth-provider.js';
import { DbApiKeyProvider } from './db-api-key-provider.js';

/**
 * Tries each member provider in order, returning the first authenticated
 * result. Used in DOMINUS Cloud to accept both a browser JWT (Auth0Provider)
 * and a CLI API key (DbApiKeyProvider) through a single AuthProvider —
 * see ADR-0032.
 */
export class CompositeAuthProvider implements AuthProvider {
  readonly name = 'CompositeAuthProvider';

  constructor(private readonly members: readonly AuthProvider[]) {
    if (members.length === 0) {
      throw new Error('CompositeAuthProvider requires at least one member provider');
    }
  }

  get isActive(): boolean {
    return this.members.some((m) => m.isActive);
  }

  get supportsKeyManagement(): boolean {
    return this.members.some((m) => m.supportsKeyManagement);
  }

  /** The member capable of API key CRUD (generate/list/revoke), if any. */
  get keyManager(): DbApiKeyProvider | undefined {
    return this.members.find((m): m is DbApiKeyProvider => m instanceof DbApiKeyProvider);
  }

  async validate(token: string): Promise<AuthResult> {
    for (const member of this.members) {
      const result = await member.validate(token);
      if (result.authenticated) {
        return result;
      }
    }
    return { authenticated: false };
  }
}
