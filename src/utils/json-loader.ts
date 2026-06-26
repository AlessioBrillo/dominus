import { existsSync, readFileSync } from 'node:fs';

export function loadJsonOverride<T>(
  path: string | undefined,
  defaults: T,
  validate: (key: string, value: unknown) => boolean,
  name: string,
): T {
  if (path === undefined || !existsSync(path)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const merged = { ...defaults } as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      if (validate(key, value)) {
        merged[key] = value;
      }
    }
    return merged as T;
  } catch {
    process.stderr.write(`[${name}] Failed to parse ${path}, using defaults\n`);
    return defaults;
  }
}
