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

/**
 * Extract the second-level label (the "name") from a domain.
 * "snapps.com"   → "snapps"
 * "my-app.io"    → "my-app"
 * "foo.co.uk"    → "foo"
 * ".com"         → ""
 * ""             → ""
 */
function sldOf(domain: string): string {
  const trimmed = domain.trim();
  if (trimmed === '') return '';
  const labels = trimmed.split('.');
  if (labels.length < 2) return trimmed;
  return labels[0] ?? '';
}

/**
 * Split a label into lowercase word tokens on any non-letter character.
 * "snapps"       → ["snapps"]
 * "my-app"       → ["my", "app"]
 * "myApp123"     → ["myapp"]
 * "1cloud"       → ["cloud"]
 */
function tokenize(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((t) => t.length > 0);
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

  /**
   * Find sales whose second-level label contains the search term as a
   * whole word token.
   *
   * The previous implementation used `s.domain.toLowerCase().includes(term)`
   * which produced false positives: searching for "app" matched
   * "snapps.com" and "appsolutely.com". The new rule tokenises the SLD on
   * non-letters and matches on exact token equality, so "app" only matches
   * "app.com", "my-app.com", or any label whose tokens include "app".
   */
  getSales(term: string): Promise<ComparableSale[]> {
    const needle = term.toLowerCase().trim();
    if (needle === '') return Promise.resolve([]);
    return Promise.resolve(
      this.sales.filter((s) => {
        const tokens = tokenize(sldOf(s.domain));
        return tokens.includes(needle);
      }),
    );
  }
}
