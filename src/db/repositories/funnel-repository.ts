import type { DatabaseProvider } from '../provider/interface.js';
import type { FunnelEntry } from '../../types/acquisition-funnel.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

export interface FunnelRow {
  id: number;
  run_id: string;
  domain: string;
  tld: string;
  source: string;
  priority_score: number;
  budget_allocation_eur: number;
  expected_return_eur: number;
  expected_value: number;
  confidence: number;
  suggested_buy_max: number;
  suggested_list_price: number;
  trademark_clear: number;
  status: string;
  created_at: string;
  tenant_id: string;
}

function rowToEntry(row: FunnelRow): FunnelEntry {
  return {
    id: row.id,
    runId: row.run_id,
    domain: row.domain,
    tld: row.tld,
    source: row.source,
    priorityScore: row.priority_score,
    budgetAllocationEur: row.budget_allocation_eur,
    expectedReturnEur: row.expected_return_eur,
    expectedValue: row.expected_value,
    confidence: row.confidence,
    suggestedBuyMax: row.suggested_buy_max,
    suggestedListPrice: row.suggested_list_price,
    trademarkClear: row.trademark_clear === 1,
    status: row.status as FunnelEntry['status'],
    createdAt: row.created_at,
  };
}

export interface InsertFunnelEntry {
  runId: string;
  domain: string;
  tld: string;
  source: string;
  priorityScore: number;
  budgetAllocationEur: number;
  expectedReturnEur: number;
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  suggestedListPrice: number;
  trademarkClear: boolean;
}

export class FunnelRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async insertBatch(entries: InsertFunnelEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const tid = resolveTenantId();
    await this.db.transaction(async (tx) => {
      for (const e of entries) {
        await tx.exec(
          `INSERT INTO funnel_entries
           (run_id, domain, tld, source, priority_score, budget_allocation_eur,
            expected_return_eur, expected_value, confidence, suggested_buy_max,
            suggested_list_price, trademark_clear, status, tenant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [
            e.runId,
            e.domain,
            e.tld,
            e.source,
            e.priorityScore,
            e.budgetAllocationEur,
            e.expectedReturnEur,
            e.expectedValue,
            e.confidence,
            e.suggestedBuyMax,
            e.suggestedListPrice,
            e.trademarkClear ? 1 : 0,
            tid,
          ],
        );
      }
    });
  }

  async findByRunId(runId: string): Promise<FunnelEntry[]> {
    const rows = await this.db.query<FunnelRow>(
      `SELECT * FROM funnel_entries
       WHERE run_id = ? AND tenant_id = ?
       ORDER BY priority_score DESC`,
      [runId, resolveTenantId()],
    );
    return rows.map(rowToEntry);
  }

  async deleteByRunId(runId: string): Promise<void> {
    await this.db.exec(`DELETE FROM funnel_entries WHERE run_id = ? AND tenant_id = ?`, [
      runId,
      resolveTenantId(),
    ]);
  }

  async updateStatus(runId: string, domain: string, status: FunnelEntry['status']): Promise<void> {
    await this.db.exec(
      `UPDATE funnel_entries SET status = ? WHERE run_id = ? AND domain = ? AND tenant_id = ?`,
      [status, runId, domain, resolveTenantId()],
    );
  }
}
