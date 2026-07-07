import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

const WEIGHT_SNAPSHOTS_DDL = `
CREATE TABLE IF NOT EXISTS weight_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  intrinsic REAL NOT NULL,
  commercial REAL NOT NULL,
  market REAL NOT NULL,
  expiry REAL NOT NULL,
  source TEXT NOT NULL
    CHECK(source IN ('init', 'manual', 'auto-tune', 'cli-override')),
  backtest_generated_at TEXT,
  sample_size INTEGER,
  notes TEXT
)
`;

const WEIGHT_SNAPSHOTS_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_weight_snapshots_snapshot_at
  ON weight_snapshots(snapshot_at DESC)
`;

const WEIGHT_SNAPSHOTS_SOURCE_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_weight_snapshots_source
  ON weight_snapshots(source)
`;

export const name = '0012_create_weight_snapshots';

export function up(db: Database.Database): void {
  db.exec(WEIGHT_SNAPSHOTS_DDL);
  db.exec(WEIGHT_SNAPSHOTS_IDX_DDL);
  db.exec(WEIGHT_SNAPSHOTS_SOURCE_IDX_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, WEIGHT_SNAPSHOTS_DDL);
  await execPg(db, WEIGHT_SNAPSHOTS_IDX_DDL);
  await execPg(db, WEIGHT_SNAPSHOTS_SOURCE_IDX_DDL);
}
