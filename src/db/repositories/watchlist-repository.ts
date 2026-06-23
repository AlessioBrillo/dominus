import type { DatabaseProvider } from '../provider/interface.js';
import type {
  WatchlistEntry,
  InsertWatchlistInput,
  UpdateWatchlistStatusInput,
} from '../../types/watchlist.js';

const ROW_MAPPER =
  'id, domain, tld, notes, last_checked_at, last_status, last_status_change, notified, created_at, updated_at';

function parseRow(row: unknown): WatchlistEntry {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as number,
    domain: r.domain as string,
    tld: r.tld as string,
    notes: (r.notes as string | null) ?? null,
    lastCheckedAt: (r.last_checked_at as string | null) ?? null,
    lastStatus: (r.last_status as string | null) ?? null,
    lastStatusChange: (r.last_status_change as string | null) ?? null,
    notified: r.notified as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class WatchlistRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async insert(input: InsertWatchlistInput): Promise<WatchlistEntry> {
    const row = await this.db.queryOne<unknown>(
      `INSERT INTO watchlist_entries (domain, tld, notes)
       VALUES (?, ?, ?)
       RETURNING ${ROW_MAPPER}`,
      [input.domain, input.tld, input.notes ?? null],
    )!;
    return parseRow(row);
  }

  async findByDomain(domain: string): Promise<WatchlistEntry | null> {
    const row = await this.db.queryOne<unknown>(
      `SELECT ${ROW_MAPPER} FROM watchlist_entries WHERE domain = ?`,
      [domain],
    );
    if (row === null) return null;
    return parseRow(row);
  }

  async list(): Promise<WatchlistEntry[]> {
    const rows = await this.db.query<unknown>(
      `SELECT ${ROW_MAPPER} FROM watchlist_entries ORDER BY created_at DESC, id DESC`,
    );
    return rows.map(parseRow);
  }

  async listPendingPoll(hoursSinceLastCheck: number): Promise<WatchlistEntry[]> {
    const rows = await this.db.query<unknown>(
      `SELECT ${ROW_MAPPER} FROM watchlist_entries
       WHERE notified = 0
          OR last_checked_at IS NULL
          OR datetime(last_checked_at) < datetime('now', ?)
       ORDER BY last_checked_at ASC NULLS FIRST`,
      [`-${hoursSinceLastCheck} hours`],
    );
    return rows.map(parseRow);
  }

  async updateStatus(domain: string, input: UpdateWatchlistStatusInput): Promise<WatchlistEntry> {
    const notified = input.notified ?? 0;
    const row = await this.db.queryOne<unknown>(
      `UPDATE watchlist_entries
       SET last_checked_at   = ?,
           last_status       = ?,
           last_status_change = ?,
           notified           = ?,
           updated_at         = datetime('now')
       WHERE domain = ?
       RETURNING ${ROW_MAPPER}`,
      [input.lastCheckedAt, input.lastStatus, input.lastStatusChange, notified, domain],
    )!;
    return parseRow(row);
  }

  async markNotified(domain: string): Promise<WatchlistEntry> {
    const row = await this.db.queryOne<unknown>(
      `UPDATE watchlist_entries
       SET notified   = 1,
           updated_at = datetime('now')
       WHERE domain = ?
       RETURNING ${ROW_MAPPER}`,
      [domain],
    )!;
    return parseRow(row);
  }

  async remove(domain: string): Promise<boolean> {
    const result = await this.db.exec('DELETE FROM watchlist_entries WHERE domain = ?', [domain]);
    return result.changes > 0;
  }

  async count(): Promise<number> {
    const row = (
      await this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM watchlist_entries')
    )!;
    return row.n;
  }
}
