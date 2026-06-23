import { z } from 'zod';
import type { DatabaseProvider } from '../provider/interface.js';
import { AlertType, AlertSeverity } from '../../types/alert.js';
import type { RenewalAlert, InsertRenewalAlertInput } from '../../types/alert.js';

const RenewalAlertRowSchema = z.object({
  id: z.number(),
  domain: z.string(),
  portfolio_entry_id: z.number(),
  alert_type: z.enum([
    AlertType.RenewalImminent,
    AlertType.RenewalCritical,
    AlertType.RenewalPastDue,
    AlertType.ScoreDropped,
  ]),
  severity: z.enum([AlertSeverity.Info, AlertSeverity.Warning, AlertSeverity.Critical]),
  message: z.string(),
  details: z.string().nullable(),
  acknowledged_at: z.string().nullable(),
  notified_channels: z.string(),
  created_at: z.string(),
});

function parseRow(row: unknown): RenewalAlert {
  const parsed = RenewalAlertRowSchema.parse(row);
  return {
    id: parsed.id,
    domain: parsed.domain,
    portfolioEntryId: parsed.portfolio_entry_id,
    alertType: parsed.alert_type as AlertType,
    severity: parsed.severity as AlertSeverity,
    message: parsed.message,
    details: parsed.details ?? undefined,
    acknowledgedAt: parsed.acknowledged_at ?? undefined,
    notifiedChannels: JSON.parse(parsed.notified_channels) as string[],
    createdAt: parsed.created_at,
  };
}

export class RenewalAlertRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async upsert(input: InsertRenewalAlertInput, channels: string[]): Promise<RenewalAlert> {
    const row = await this.db.queryOne<unknown>(
      `INSERT INTO renewal_alerts
         (domain, portfolio_entry_id, alert_type, severity, message, details, notified_channels)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, alert_type) DO UPDATE SET
         severity          = excluded.severity,
         message           = excluded.message,
         details           = COALESCE(excluded.details, renewal_alerts.details),
         notified_channels = excluded.notified_channels,
         acknowledged_at   = NULL
       RETURNING *`,
      [
        input.domain,
        input.portfolioEntryId,
        input.alertType,
        input.severity,
        input.message,
        input.details ?? null,
        JSON.stringify(channels),
      ],
    )!;
    return parseRow(row);
  }

  async findAll(domain?: string, unacknowledgedOnly = false): Promise<RenewalAlert[]> {
    let sql = 'SELECT * FROM renewal_alerts WHERE 1=1';
    const params: unknown[] = [];

    if (domain !== undefined) {
      sql += ' AND domain = ?';
      params.push(domain);
    }
    if (unacknowledgedOnly) {
      sql += ' AND acknowledged_at IS NULL';
    }
    sql += ' ORDER BY created_at DESC, id DESC';

    const rows = await this.db.query<unknown>(sql, params);
    return rows.map(parseRow);
  }

  async findById(id: number): Promise<RenewalAlert | null> {
    const row = await this.db.queryOne<unknown>('SELECT * FROM renewal_alerts WHERE id = ?', [id]);
    if (row === null) return null;
    try {
      return parseRow(row);
    } catch {
      return null;
    }
  }

  async acknowledge(id: number): Promise<void> {
    await this.db.exec("UPDATE renewal_alerts SET acknowledged_at = datetime('now') WHERE id = ?", [
      id,
    ]);
  }

  async acknowledgeAll(domain?: string): Promise<number> {
    let sql =
      "UPDATE renewal_alerts SET acknowledged_at = datetime('now') WHERE acknowledged_at IS NULL";
    const params: unknown[] = [];
    if (domain !== undefined) {
      sql += ' AND domain = ?';
      params.push(domain);
    }
    const result = await this.db.exec(sql, params);
    return result.changes;
  }

  async deleteBefore(date: string): Promise<number> {
    const result = await this.db.exec(
      'DELETE FROM renewal_alerts WHERE created_at < ? AND acknowledged_at IS NOT NULL',
      [date],
    );
    return result.changes;
  }

  async count(domain?: string): Promise<number> {
    if (domain !== undefined) {
      const row = (await this.db.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM renewal_alerts WHERE domain = ?',
        [domain],
      ))!;
      return row.n;
    }
    const row = (await this.db.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM renewal_alerts',
    ))!;
    return row.n;
  }

  /** Return the most recent alert for each unacknowledged domain. */
  async latestPerDomain(): Promise<RenewalAlert[]> {
    const rows = await this.db.query<unknown>(
      `SELECT a.* FROM renewal_alerts a
       INNER JOIN (
         SELECT domain, MAX(id) AS max_id
         FROM renewal_alerts
         WHERE acknowledged_at IS NULL
         GROUP BY domain
       ) latest ON a.id = latest.max_id
       ORDER BY a.created_at DESC`,
    );
    return rows.map(parseRow);
  }
}
