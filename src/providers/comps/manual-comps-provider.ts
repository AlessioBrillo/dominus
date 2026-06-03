import { readFileSync, existsSync } from 'node:fs';
import type { ComparableSale, CompsProvider } from './comps-provider.js';

interface CsvRow {
  domain: string;
  price: string;
  date: string;
  venue: string;
}

function parseCsv(content: string): CsvRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length >= 4) {
      rows.push({
        domain: (parts[0] ?? '').trim(),
        price: (parts[1] ?? '').trim(),
        date: (parts[2] ?? '').trim(),
        venue: (parts[3] ?? '').trim(),
      });
    }
  }
  return rows;
}

export class ManualCompsProvider implements CompsProvider {
  private readonly sales: ComparableSale[];

  constructor(csvFilePath?: string) {
    this.sales = [];
    if (csvFilePath && existsSync(csvFilePath)) {
      const content = readFileSync(csvFilePath, 'utf-8');
      for (const row of parseCsv(content)) {
        const price = parseFloat(row.price);
        if (!isNaN(price)) {
          this.sales.push({
            domain: row.domain,
            salePrice: price,
            saleDate: row.date,
            venue: row.venue,
          });
        }
      }
    }
  }

  getSales(term: string): Promise<ComparableSale[]> {
    const lower = term.toLowerCase();
    return Promise.resolve(this.sales.filter((s) => s.domain.toLowerCase().includes(lower)));
  }
}
