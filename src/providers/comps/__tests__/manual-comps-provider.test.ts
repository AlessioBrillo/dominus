import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManualCompsProvider } from '../manual-comps-provider.js';

function writeCsv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dominus-comps-'));
  const path = join(dir, 'comps.csv');
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('ManualCompsProvider', () => {
  it('returns empty array when no data file', async () => {
    const provider = new ManualCompsProvider();
    const sales = await provider.getSales('app');
    expect(sales).toEqual([]);
  });

  it('returns empty array for unmatched term', async () => {
    const provider = new ManualCompsProvider();
    const sales = await provider.getSales('xyzqwerty');
    expect(sales).toEqual([]);
  });
});

describe('ManualCompsProvider — word-boundary matching', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dominus-comps-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches an exact SLD token (app matches app.com)', async () => {
    // Arrange
    const path = writeCsv('domain,price,date,venue\napp.com,1000,2025-01-01,namecheap\n');
    const provider = new ManualCompsProvider(path);

    // Act + Assert
    const out = await provider.getSales('app');
    expect(out).toHaveLength(1);
    expect(out[0]?.domain).toBe('app.com');
  });

  it('does NOT match a substring (app does not match snapps.com)', async () => {
    // Arrange — the bug the rewrite fixes
    const path = writeCsv(
      'domain,price,date,venue\nsnapps.com,500,2025-01-01,namecheap\nappsolutely.com,800,2025-02-01,sedo\n',
    );
    const provider = new ManualCompsProvider(path);

    // Act + Assert
    const out = await provider.getSales('app');
    expect(out).toEqual([]);
  });

  it('matches when the term is one of several hyphenated tokens', async () => {
    // Arrange
    const path = writeCsv(
      'domain,price,date,venue\nmy-app.com,2000,2025-01-01,sedo\nmy-app.io,1500,2025-02-01,dan\nmy-cloud.com,3000,2025-03-01,atom\n',
    );
    const provider = new ManualCompsProvider(path);

    // Act + Assert
    const out = await provider.getSales('app');
    expect(out.map((s) => s.domain).sort()).toEqual(['my-app.com', 'my-app.io']);
  });

  it('is case-insensitive on the term', async () => {
    // Arrange
    const path = writeCsv('domain,price,date,venue\nMyApp.com,2000,2025-01-01,sedo\n');
    const provider = new ManualCompsProvider(path);

    // Act + Assert
    expect(await provider.getSales('myapp')).toHaveLength(1);
    expect(await provider.getSales('MYAPP')).toHaveLength(1);
  });

  it('strips non-letter characters from the SLD before tokenising', async () => {
    // Arrange — the SLD "1cloud" tokenises to ["cloud"]
    const path = writeCsv('domain,price,date,venue\n1cloud.com,2500,2025-01-01,sedo\n');
    const provider = new ManualCompsProvider(path);

    // Act + Assert — searching "cloud" matches; "1cloud" does not
    expect(await provider.getSales('cloud')).toHaveLength(1);
    expect(await provider.getSales('1cloud')).toEqual([]);
  });

  it('returns no matches for an empty or whitespace-only term', async () => {
    // Arrange
    const path = writeCsv('domain,price,date,venue\napp.com,1000,2025-01-01,namecheap\n');
    const provider = new ManualCompsProvider(path);

    // Act + Assert
    expect(await provider.getSales('')).toEqual([]);
    expect(await provider.getSales('   ')).toEqual([]);
  });

  it('handles multi-label ccTLDs by tokenising the SLD only', async () => {
    // Arrange — foo.co.uk → SLD = "foo"
    const path = writeCsv(
      'domain,price,date,venue\nfoo.co.uk,1000,2025-01-01,sedo\nbar.co.uk,500,2025-01-01,dan\n',
    );
    const provider = new ManualCompsProvider(path);

    // Act + Assert
    const out = await provider.getSales('foo');
    expect(out).toHaveLength(1);
    expect(out[0]?.domain).toBe('foo.co.uk');
  });
});
