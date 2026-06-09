import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManualKeywordProvider } from '../manual-keyword-provider.js';

describe('ManualKeywordProvider', () => {
  it('returns zero metrics for unknown term when no data file', async () => {
    const provider = new ManualKeywordProvider();
    const metrics = await provider.getMetrics('unknownterm');
    expect(metrics.monthlySearchVolume).toBe(0);
    expect(metrics.cpc).toBe(0);
    expect(metrics.term).toBe('unknownterm');
  });

  it('is case-insensitive for lookups', async () => {
    const provider = new ManualKeywordProvider();
    const a = await provider.getMetrics('SaaS');
    const b = await provider.getMetrics('saas');
    expect(a.monthlySearchVolume).toBe(b.monthlySearchVolume);
  });

  describe('with data file', () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('loads keyword data from valid JSON and returns metrics', async () => {
      dir = mkdtempSync(join(tmpdir(), 'kw-'));
      const path = join(dir, 'data.json');
      writeFileSync(
        path,
        JSON.stringify([{ term: 'saas', monthlySearchVolume: 10000, cpc: 5.5, competition: 0.3 }]),
        'utf-8',
      );
      const provider = new ManualKeywordProvider(path);
      const metrics = await provider.getMetrics('saas');
      expect(metrics.monthlySearchVolume).toBe(10000);
      expect(metrics.cpc).toBe(5.5);
      expect(metrics.competition).toBe(0.3);
    });

    it('handles non-existent data file gracefully', async () => {
      const provider = new ManualKeywordProvider('/nonexistent/path.json');
      const metrics = await provider.getMetrics('saas');
      expect(metrics.monthlySearchVolume).toBe(0);
    });
  });
});
