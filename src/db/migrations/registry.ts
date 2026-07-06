import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Migration {
  name: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

async function loadAll(): Promise<Migration[]> {
  const files = readdirSync(__dirname)
    .filter(
      (f) => /^\d{4}/.test(f) && (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.d.ts'),
    )
    .sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const mod = await import(`./${file}`);
    if (!mod.name || !mod.up) {
      throw new Error(`Migration ${file} must export 'name' (string) and 'up' (function)`);
    }
    migrations.push({ name: mod.name, up: mod.up, down: mod.down });
  }
  return migrations;
}

const MIGRATIONS: Migration[] = await loadAll();

/** All discovered SQLite migrations, pre-loaded at import time via top-level await. */
export function getMigrations(): Migration[] {
  return MIGRATIONS;
}

/** Synchronously list migration names from the filesystem. */
export function getMigrationNames(): string[] {
  return readdirSync(__dirname)
    .filter(
      (f) => /^\d{4}/.test(f) && (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.d.ts'),
    )
    .sort()
    .map((f) => f.replace(/\.(ts|js)$/, ''));
}
