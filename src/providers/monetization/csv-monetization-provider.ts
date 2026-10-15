// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, existsSync } from 'node:fs';
import type { MonetizationProvider, RevenueRecord } from '../../types/monetization.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

interface CsvRow {
  domain: string;
  date: string;
  amount: string;
}

/**
 * Minimal CSV parser for the revenue export (same shape as the comps
 * provider: header line, comma separated, no quoting). Parking providers
 * and AdSense-style dashboards all export this shape.
 */
function parseCsv(content: string): CsvRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length >= 3) {
      rows.push({
        domain: (parts[0] ?? '').trim(),
        date: (parts[1] ?? '').trim(),
        amount: (parts[2] ?? '').trim(),
      });
    }
  }
  return rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CSV monetization provider (ADR-0083, M3).
 *
 * The first working monetization provider of the community edition: it
 * reads a revenue export (columns `domain,date,amount_eur`) from a
 * configured path. Zero paid API dependencies — the operator exports the
 * CSV from their parking/ads dashboard, DOMINUS ingests it through the
 * very same interface a provider API adapter will implement later.
 * Revenue ingestion is a read: nothing here mutates external state.
 */
export class CsvMonetizationProvider implements MonetizationProvider {
  readonly name = 'csv';

  readonly #path: string | undefined;

  constructor(path?: string | undefined) {
    this.#path = path;
  }

  get isAvailable(): boolean {
    return this.#path !== undefined && existsSync(this.#path);
  }

  async fetchRevenue(since: string): Promise<RevenueRecord[]> {
    if (!this.isAvailable || this.#path === undefined) return [];

    const content = readFileSync(this.#path, 'utf-8');
    const fetchedAt = new Date().toISOString();
    const records: RevenueRecord[] = [];

    for (const row of parseCsv(content)) {
      if (row.domain === '' || !ISO_DATE.test(row.date)) continue;
      if (row.date < since) continue;
      const amount = Number.parseFloat(row.amount);
      if (!Number.isFinite(amount)) continue;
      records.push({
        domain: row.domain,
        date: row.date,
        amountEur: amount,
        source: this.name,
        fetchedAt,
      });
    }

    logger.debug(
      { path: this.#path, since, records: records.length },
      'CsvMonetizationProvider: revenue read',
    );
    return records;
  }
}
