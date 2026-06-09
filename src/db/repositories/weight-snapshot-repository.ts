import type Database from 'better-sqlite3';
import type {
  WeightSnapshot,
  WeightSnapshotSource,
  InsertWeightSnapshotInput,
} from '../../types/weight-snapshot.js';

interface WeightSnapshotRow {
  id: number;
  snapshot_at: string;
  intrinsic: number;
  commercial: number;
  market: number;
  expiry: number;
  source: string;
  backtest_generated_at: string | null;
  sample_size: number | null;
  notes: string | null;
}

function rowToSnapshot(row: WeightSnapshotRow): WeightSnapshot {
  return {
    id: row.id,
    snapshotAt: row.snapshot_at,
    intrinsic: row.intrinsic,
    commercial: row.commercial,
    market: row.market,
    expiry: row.expiry,
    source: row.source as WeightSnapshotSource,
    backtestGeneratedAt: row.backtest_generated_at,
    sampleSize: row.sample_size,
    notes: row.notes,
  };
}

export class WeightSnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: InsertWeightSnapshotInput): WeightSnapshot {
    const row = this.db
      .prepare(
        `INSERT INTO weight_snapshots
         (intrinsic, commercial, market, expiry, source,
          backtest_generated_at, sample_size, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        input.intrinsic,
        input.commercial,
        input.market,
        input.expiry,
        input.source,
        input.backtestGeneratedAt ?? null,
        input.sampleSize ?? null,
        input.notes ?? null,
      ) as { id: number };

    const stored = this.db
      .prepare('SELECT * FROM weight_snapshots WHERE id = ?')
      .get(row.id) as WeightSnapshotRow;
    return rowToSnapshot(stored);
  }

  findAll(limit = 50): WeightSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM weight_snapshots ORDER BY snapshot_at DESC LIMIT ?')
      .all(limit) as WeightSnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  findLatest(): WeightSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM weight_snapshots ORDER BY snapshot_at DESC LIMIT 1')
      .get() as WeightSnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  findBySource(source: WeightSnapshotSource): WeightSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM weight_snapshots WHERE source = ? ORDER BY snapshot_at DESC')
      .all(source) as WeightSnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM weight_snapshots').get() as {
      n: number;
    };
    return row.n;
  }
}
