import type { AuthProvider, AuthResult } from './auth-provider.js';

/**
 * Reads API keys from the `API_KEYS` environment variable.
 * Format: comma-separated values, each optionally prefixed with `name=`:
 *   API_KEYS=sk-abc123,admin=sk-admin-key,monitor=sk-mon-key
 *
 * When `API_KEYS` is empty or unset, no keys are accepted (auth disabled).
 */
export class EnvApiKeyProvider implements AuthProvider {
  readonly name = 'EnvApiKeyProvider';

  private readonly keys: Map<string, string> = new Map();
  private readonly active: boolean;

  constructor(apiKeysEnv: string | undefined) {
    if (!apiKeysEnv || apiKeysEnv.trim().length === 0) {
      this.active = false;
      return;
    }

    this.active = true;
    for (const entry of apiKeysEnv.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0 && eqIndex < trimmed.length - 1) {
        const name = trimmed.slice(0, eqIndex);
        const key = trimmed.slice(eqIndex + 1);
        this.keys.set(key, name);
      } else {
        this.keys.set(trimmed, 'default');
      }
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  async validate(apiKey: string): Promise<AuthResult> {
    if (!this.active) {
      return { authenticated: false };
    }
    const keyName = this.keys.get(apiKey);
    if (keyName !== undefined) {
      return { authenticated: true, keyName };
    }
    return { authenticated: false };
  }
}
