import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0040_add_metric_retries_and_error_codes';

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE pipeline_metrics
      ADD COLUMN retries INTEGER NOT NULL DEFAULT 0
  `);
  db.exec(`
    ALTER TABLE pipeline_metrics
      ADD COLUMN error_codes TEXT NOT NULL DEFAULT '[]'
  `);
  db.exec(`
    ALTER TABLE pipeline_metrics
      ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    ALTER TABLE pipeline_metrics
      ADD COLUMN IF NOT EXISTS retries INTEGER NOT NULL DEFAULT 0
  `,
  );
  await execPg(
    db,
    `
    ALTER TABLE pipeline_metrics
      ADD COLUMN IF NOT EXISTS error_codes TEXT NOT NULL DEFAULT '[]'
  `,
  );
  await execPg(
    db,
    `
    ALTER TABLE pipeline_metrics
      ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'
  `,
  );
}
