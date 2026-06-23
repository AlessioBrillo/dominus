import type { DatabaseProvider } from '../provider/interface.js';
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
  constructor(private readonly db: DatabaseProvider) {}

  async insert(input: InsertWeightSnapshotInput): Promise<WeightSnapshot> {
    const row = (await this.db.queryOne<{ id: number }>(
      `INSERT INTO weight_snapshots
         (intrinsic, commercial, market, expiry, source,
          backtest_generated_at, sample_size, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      [
        input.intrinsic,
        input.commercial,
        input.market,
        input.expiry,
        input.source,
        input.backtestGeneratedAt ?? null,
        input.sampleSize ?? null,
        input.notes ?? null,
      ],
    ))!;

    const stored = (await this.db.queryOne<WeightSnapshotRow>(
      'SELECT * FROM weight_snapshots WHERE id = ?',
      [row.id],
    ))!;
    return rowToSnapshot(stored);
  }

  async findAll(limit = 50): Promise<WeightSnapshot[]> {
    const rows = await this.db.query<WeightSnapshotRow>(
      'SELECT * FROM weight_snapshots ORDER BY snapshot_at DESC LIMIT ?',
      [limit],
    );
    return rows.map(rowToSnapshot);
  }

  async findLatest(): Promise<WeightSnapshot | null> {
    const row = await this.db.queryOne<WeightSnapshotRow>(
      'SELECT * FROM weight_snapshots ORDER BY snapshot_at DESC LIMIT 1',
    );
    return row ? rowToSnapshot(row) : null;
  }

  async findBySource(source: WeightSnapshotSource): Promise<WeightSnapshot[]> {
    const rows = await this.db.query<WeightSnapshotRow>(
      'SELECT * FROM weight_snapshots WHERE source = ? ORDER BY snapshot_at DESC',
      [source],
    );
    return rows.map(rowToSnapshot);
  }

  async count(): Promise<number> {
    const row = (await this.db.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM weight_snapshots',
    ))!;
    return row.n;
  }
}
