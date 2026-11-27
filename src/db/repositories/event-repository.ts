// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import { runWithTenant } from '../../utils/tenant-context.js';

/**
 * First-party product events. The `events` table already exists (migration
 * 0025), is RLS-protected and carries `anon_id` for pre-signup traffic. A
 * separate table would duplicate both the schema and the retention rules.
 */
export interface ProductEvent {
  tenantId: string;
  anonId?: string | null;
  type: string;
  props?: Record<string, unknown>;
}

export interface FunnelCounts {
  signup: number;
  verified: number;
  firstScore: number;
  portfolioImport: number;
  checkoutCompleted: number;
}

const FUNNEL_TYPES = [
  'signup',
  'verified',
  'first_score',
  'portfolio_import',
  'checkout_completed',
] as const;

export class EventRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async record(event: ProductEvent): Promise<void> {
    await this.db.exec('INSERT INTO events (tenant_id, anon_id, type, props) VALUES (?, ?, ?, ?)', [
      event.tenantId,
      event.anonId ?? null,
      event.type,
      JSON.stringify(event.props ?? {}),
    ]);
  }

  /**
   * Record an event at most once per tenant. The funnel counts first-time
   * milestones (`first_score`, `portfolio_import`); without this guard a
   * second score or a second import would inflate activation (ADR-0117).
   */
  async recordOnce(event: ProductEvent): Promise<boolean> {
    const row = await this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM events WHERE tenant_id = ? AND type = ?',
      [event.tenantId, event.type],
    );
    if (Number(row?.count ?? 0) > 0) return false;
    await this.record(event);
    return true;
  }

  /** Counts by event type. Used by the operator funnel, not by billing. */
  async funnelCounts(): Promise<FunnelCounts> {
    // Funnel events are written under the `public` tenant so the operator can
    // read them across workspaces. RLS on `events` denies a read without that
    // context, so the aggregate must run inside it (P1 review, PR #564).
    const rows = await runWithTenant('public', () =>
      this.db.query<{ type: string; count: number }>(
        `SELECT type, COUNT(*) AS count FROM events WHERE type IN (?, ?, ?, ?, ?) GROUP BY type`,
        [...FUNNEL_TYPES],
      ),
    );
    const byType = new Map(rows.map((row) => [row.type, Number(row.count)]));
    return {
      signup: byType.get('signup') ?? 0,
      verified: byType.get('verified') ?? 0,
      firstScore: byType.get('first_score') ?? 0,
      portfolioImport: byType.get('portfolio_import') ?? 0,
      checkoutCompleted: byType.get('checkout_completed') ?? 0,
    };
  }
}
