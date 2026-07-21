import { readFileSync, existsSync, statSync } from 'node:fs';
import type { AuthProvider, AuthResult } from './auth-provider.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const OWNER_ONLY_MODE = 0o600;

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
 *
 * Security: when loading from a file, the file permissions are validated
 * to warn if the file is world-readable (permissions > 0600).
 */
export class EnvApiKeyProvider implements AuthProvider {
  readonly name = 'EnvApiKeyProvider';
  readonly supportsKeyManagement = false;

  private readonly keys: Map<string, string> = new Map();
  private readonly active: boolean;

  constructor(apiKeysEnv: string | undefined, fileApiKeysPath?: string | undefined) {
    if (fileApiKeysPath && fileApiKeysPath.length > 0) {
      checkFilePermissions(fileApiKeysPath);
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
      return { authenticated: true, keyName, tenantId: 'default' };
    }
    return { authenticated: false };
  }
}

function checkFilePermissions(filePath: string): void {
  try {
    const stats = statSync(filePath);
    if (process.platform !== 'win32') {
      const mode = stats.mode & 0o777;
      const isWorldReadable = (mode & 0o004) !== 0 || (mode & 0o044) !== 0;
      if (isWorldReadable) {
        logger.warn(
          { path: filePath, mode: mode.toString(8) },
          `API keys file has permissions ${mode.toString(8)} — world-readable. ` +
            `Recommended: chmod ${OWNER_ONLY_MODE.toString(8)} to restrict access to owner only.`,
        );
      }
    } else {
      if (existsSync(filePath)) {
        logger.info(
          { path: filePath },
          'File permission check skipped on Windows (POSIX permissions not applicable)',
        );
      }
    }
  } catch (err) {
    logger.warn({ path: filePath, err }, 'Could not check file permissions for API keys file');
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
