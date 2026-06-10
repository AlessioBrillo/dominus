import { readFileSync, existsSync } from 'node:fs';
import type { AuthProvider, AuthResult } from './auth-provider.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

/**
 * Reads API keys from the `API_KEYS` environment variable or from a file
 * specified via `FILE_API_KEYS`. When `FILE_API_KEYS` is set, it takes
 * precedence over `API_KEYS`.
 *
 * Env var format: comma-separated values, each optionally prefixed with `name=`:
 *   API_KEYS=sk-abc123,admin=sk-admin-key,monitor=sk-mon-key
 *
 * File format: one key per line, each optionally prefixed with `name=`:
 *   sk-abc123
 *   admin=sk-admin-key
 *   monitor=sk-mon-key
 *
 * When no keys are configured, auth is disabled.
 */
export class EnvApiKeyProvider implements AuthProvider {
  readonly name = 'EnvApiKeyProvider';

  private readonly keys: Map<string, string> = new Map();
  private readonly active: boolean;

  constructor(apiKeysEnv: string | undefined, fileApiKeysPath?: string | undefined) {
    // FILE_API_KEYS takes precedence over API_KEYS env var
    if (fileApiKeysPath && fileApiKeysPath.length > 0) {
      const parsed = parseFileKeys(fileApiKeysPath);
      if (parsed.length > 0) {
        this.active = true;
        for (const { key, name } of parsed) {
          this.keys.set(key, name);
        }
        logger.info(
          { source: fileApiKeysPath, keyCount: parsed.length },
          'Loaded API keys from file',
        );
        return;
      }
    }

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

function parseFileKeys(filePath: string): Array<{ key: string; name: string }> {
  if (!existsSync(filePath)) {
    logger.warn({ path: filePath }, 'API keys file not found');
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed: Array<{ key: string; name: string }> = [];

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0 && eqIndex < trimmed.length - 1) {
        const name = trimmed.slice(0, eqIndex);
        const key = trimmed.slice(eqIndex + 1);
        parsed.push({ key, name });
      } else {
        parsed.push({ key: trimmed, name: 'default' });
      }
    }

    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ path: filePath, error: msg }, 'Failed to read API keys file');
    return [];
  }
}
