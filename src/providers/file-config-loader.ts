import { readFileSync, existsSync } from 'node:fs';

/**
 * Load configuration key-value pairs from a file (one per line,
 * `key=value` format). Lines starting with `#` are comments.
 * Empty lines are ignored. Values are trimmed.
 *
 * This provides a more secure alternative to environment variables
 * for sensitive data (API keys, tokens) since file contents are
 * not visible in `/proc/self/environ`.
 *
 * File should have permissions 0600.
 */
export function loadFileConfig(filePath: string): Record<string, string> {
  const config: Record<string, string> = {};

  if (!existsSync(filePath)) {
    return config;
  }

  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key.length > 0 && value.length > 0) {
      config[key] = value;
    }
  }

  return config;
}
