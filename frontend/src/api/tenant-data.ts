// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client';

/** The exact shape returned by GET /api/v1/tenant/export (art. 15). */
export interface TenantExport {
  tenantId: string;
  generatedAt: string;
  formatVersion: number;
  tables: Array<{ table: string; rows: Record<string, unknown>[]; truncated: boolean }>;
  totalRows: number;
  retainedTables: string[];
}

export interface TenantDeletionReport {
  tenantId: string;
  deletedAt: string;
  tables: Array<{ table: string; rows: number; retained: boolean }>;
  totalRows: number;
  liveDataErased: boolean;
  subscriptionCancelled: boolean | null;
}

/** A machine-readable copy of everything the workspace holds (GDPR art. 15). */
export function exportTenantData(): Promise<TenantExport> {
  return api.get<TenantExport>('/tenant/export');
}

/** Erase the workspace after a typed confirmation (GDPR art. 17). */
export function eraseTenant(confirm: string): Promise<TenantDeletionReport> {
  return api.deleteWithBody<TenantDeletionReport>('/tenant', { confirm });
}
