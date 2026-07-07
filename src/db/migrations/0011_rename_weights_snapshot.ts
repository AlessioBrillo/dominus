import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0011_rename_weights_snapshot';

export function up(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info('scoring_runs')`).all() as { name: string }[];

  const hasOld = columns.some((c) => c.name === 'weights_snapshot');
  const hasNew = columns.some((c) => c.name === 'signal_scores');

  if (hasOld && !hasNew) {
    db.exec(`ALTER TABLE scoring_runs RENAME COLUMN weights_snapshot TO signal_scores`);
  }
}

export async function upPg(_db: DatabaseProvider): Promise<void> {
  // PG schema already has signal_scores from creation
}
