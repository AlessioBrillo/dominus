import type { DatabaseProvider } from '../provider/interface.js';
import type { AutoListing, AutoListSource, NewAutoListing } from '../../types/listing.js';
import { autoListingFromRow, type AutoListingRow } from '../../types/listing.js';

export class AutoListingRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async insert(input: NewAutoListing): Promise<{ id: number }> {
    const result = await this.db.exec(
      `INSERT INTO auto_listings (domain, listing_id, trigger_source, pipeline_run_id, score_snapshot_json, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [
        input.domain,
        input.listingId,
        input.triggerSource,
        input.pipelineRunId ?? null,
        input.scoreSnapshotJson ?? null,
      ],
    );
    return { id: result.lastInsertRowid as number };
  }

  async findByDomain(domain: string): Promise<AutoListing[]> {
    const rows = await this.db.query<AutoListingRow>(
      'SELECT * FROM auto_listings WHERE domain = ? ORDER BY auto_listed_at DESC',
      [domain],
    );
    return rows.map(autoListingFromRow);
  }

  async findByListingId(listingId: number): Promise<AutoListing | undefined> {
    const row = await this.db.queryOne<AutoListingRow>(
      'SELECT * FROM auto_listings WHERE listing_id = ? ORDER BY auto_listed_at DESC LIMIT 1',
      [listingId],
    );
    return row ? autoListingFromRow(row) : undefined;
  }

  async findBySource(source: AutoListSource): Promise<AutoListing[]> {
    const rows = await this.db.query<AutoListingRow>(
      'SELECT * FROM auto_listings WHERE trigger_source = ? ORDER BY auto_listed_at DESC',
      [source],
    );
    return rows.map(autoListingFromRow);
  }

  async updateStatus(id: number, status: 'active' | 'superseded' | 'cancelled'): Promise<void> {
    await this.db.exec('UPDATE auto_listings SET status = ? WHERE id = ?', [status, id]);
  }

  async supersedeByDomain(domain: string): Promise<void> {
    await this.db.exec(
      "UPDATE auto_listings SET status = 'superseded' WHERE domain = ? AND status = 'active'",
      [domain],
    );
  }
}
