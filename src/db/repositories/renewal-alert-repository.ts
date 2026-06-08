import { z } from 'zod';
import type Database from 'better-sqlite3';
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
  constructor(private readonly db: Database.Database) {}

  upsert(input: InsertRenewalAlertInput, channels: string[]): RenewalAlert {
    const row = this.db
      .prepare(
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
      )
      .get(
        input.domain,
        input.portfolioEntryId,
        input.alertType,
        input.severity,
        input.message,
        input.details ?? null,
        JSON.stringify(channels),
      );
    return parseRow(row);
  }

  findAll(domain?: string, unacknowledgedOnly = false): RenewalAlert[] {
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

    const rows = this.db.prepare(sql).all(...params);
    return (rows as unknown[]).map(parseRow);
  }

  findById(id: number): RenewalAlert | null {
    const row = this.db.prepare('SELECT * FROM renewal_alerts WHERE id = ?').get(id);
    if (row === undefined) return null;
    try {
      return parseRow(row);
    } catch {
      return null;
    }
  }

  acknowledge(id: number): void {
    this.db
      .prepare("UPDATE renewal_alerts SET acknowledged_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  acknowledgeAll(domain?: string): number {
    let sql = "UPDATE renewal_alerts SET acknowledged_at = datetime('now') WHERE acknowledged_at IS NULL";
    const params: unknown[] = [];
    if (domain !== undefined) {
      sql += ' AND domain = ?';
      params.push(domain);
    }
    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  deleteBefore(date: string): number {
    const result = this.db
      .prepare('DELETE FROM renewal_alerts WHERE created_at < ? AND acknowledged_at IS NOT NULL')
      .run(date);
    return result.changes;
  }

  count(domain?: string): number {
    if (domain !== undefined) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM renewal_alerts WHERE domain = ?')
        .get(domain) as { n: number };
      return row.n;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM renewal_alerts').get() as {
      n: number;
    };
    return row.n;
  }

  /** Return the most recent alert for each unacknowledged domain. */
  latestPerDomain(): RenewalAlert[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM renewal_alerts a
         INNER JOIN (
           SELECT domain, MAX(id) AS max_id
           FROM renewal_alerts
           WHERE acknowledged_at IS NULL
           GROUP BY domain
         ) latest ON a.id = latest.max_id
         ORDER BY a.created_at DESC`,
      )
      .all();
    return (rows as unknown[]).map(parseRow);
  }
}
