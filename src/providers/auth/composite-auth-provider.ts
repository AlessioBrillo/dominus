// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthProvider, AuthResult, KeyManager } from './auth-provider.js';

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

  /** The first member capable of API key CRUD (generate/list/revoke), if any. */
  asKeyManager(): KeyManager | undefined {
    for (const m of this.members) {
      const km = m.asKeyManager();
      if (km) return km as KeyManager;
    }
    return undefined;
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
