// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvMonetizationProvider } from '../csv-monetization-provider.js';

let dir: string;
let csvPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dominus-revenue-'));
  csvPath = join(dir, 'revenue.csv');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEADER = 'domain,date,amount_eur\n';

describe('CsvMonetizationProvider', () => {
  it('is unavailable when no path is configured', () => {
    const provider = new CsvMonetizationProvider(undefined);
    expect(provider.isAvailable).toBe(false);
  });

  it('is unavailable when the file does not exist', () => {
    const provider = new CsvMonetizationProvider(join(dir, 'missing.csv'));
    expect(provider.isAvailable).toBe(false);
  });

  it('reads and normalises valid rows', async () => {
    writeFileSync(
      csvPath,
      `${HEADER}vintagecoffee.com,2026-10-01,1.25\nvintagecoffee.com,2026-10-02,0.50\n`,
      'utf-8',
    );
    const provider = new CsvMonetizationProvider(csvPath);

    const records = await provider.fetchRevenue('2026-01-01');

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      domain: 'vintagecoffee.com',
      date: '2026-10-01',
      amountEur: 1.25,
      source: 'csv',
      fetchedAt: expect.any(String),
    });
  });

  it('filters by the since date, inclusive', async () => {
    writeFileSync(
      csvPath,
      `${HEADER}vintagecoffee.com,2026-09-30,9.99\nvintagecoffee.com,2026-10-01,1.25\n`,
      'utf-8',
    );
    const provider = new CsvMonetizationProvider(csvPath);

    const records = await provider.fetchRevenue('2026-10-01');

    expect(records).toHaveLength(1);
    expect(records[0]?.date).toBe('2026-10-01');
  });

  it('skips malformed rows and keeps negative corrections', async () => {
    writeFileSync(
      csvPath,
      `${HEADER}vintagecoffee.com,not-a-date,1.00\nvintagecoffee.com,2026-10-01,abc\n,2026-10-01,1.00\nvintagecoffee.com,2026-10-01,-0.25\n`,
      'utf-8',
    );
    const provider = new CsvMonetizationProvider(csvPath);

    const records = await provider.fetchRevenue('2026-01-01');

    expect(records).toHaveLength(1);
    expect(records[0]?.amountEur).toBe(-0.25);
  });

  it('returns an empty array for a header-only file', async () => {
    writeFileSync(csvPath, HEADER, 'utf-8');
    const provider = new CsvMonetizationProvider(csvPath);

    expect(await provider.fetchRevenue('2026-01-01')).toEqual([]);
  });

  it('fetchRevenue is a no-op when unavailable', async () => {
    const provider = new CsvMonetizationProvider(undefined);
    expect(await provider.fetchRevenue('2026-01-01')).toEqual([]);
  });
});
