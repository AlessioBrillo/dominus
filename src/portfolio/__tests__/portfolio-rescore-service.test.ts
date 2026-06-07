import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import type { TrademarkMatch } from '../../providers/trademark/trademark-provider.js';
import {
  makeFakeRescoreDeps,
  makeServiceFromFakes,
  makePortfolioEntry,
} from './rescore-test-helpers.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeBlockedMatch(markName: string): TrademarkMatch {
  return { markName, owner: 'Acme Corp', status: 'live', source: 'USPTO' };
}

describe('PortfolioRescoreService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  describe('happy path', () => {
    it('produces a RescoreOutcome for each portfolio entry', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      const { service } = makeServiceFromFakes(deps);
      const entries = [
        makePortfolioEntry({ domain: 'alpha.com' }),
        makePortfolioEntry({ domain: 'beta.io', tld: '.io' }),
      ];

      // Act
      const summary = await service.rescore(entries);

      // Assert
      expect(summary.results).toHaveLength(2);
      expect(summary.results.map((r) => r.domain)).toEqual(['alpha.com', 'beta.io']);
      expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('produces a 0-100 calibratedScore from the engine weightedScore', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      const { service } = makeServiceFromFakes(deps);

      // Act
      const summary = await service.rescore([makePortfolioEntry({ domain: 'alpha.com' })]);

      // Assert
      const r = summary.results[0]!;
      expect(r.calibratedScore).toBe(Math.round(r.weightedScore * 100));
      expect(r.calibratedScore).toBeGreaterThanOrEqual(0);
      expect(r.calibratedScore).toBeLessThanOrEqual(100);
    });

    it('sets trademarkClear=true when both providers respond and no match', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      const { service } = makeServiceFromFakes(deps);

      // Act
      const summary = await service.rescore([makePortfolioEntry({ domain: 'alpha.com' })]);

      // Assert
      const r = summary.results[0]!;
      expect(r.trademarkVerdict).toBe(GateVerdict.Clear);
      expect(r.trademarkClear).toBe(true);
      expect(r.verifiedSources).toEqual(['USPTO', 'EUIPO']);
      expect(r.matchedMark).toBeUndefined();
    });
  });

  describe('trademark gate', () => {
    it('flags a domain as blocked when USPTO finds a matching mark', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      vi.mocked(deps.uspto.search).mockResolvedValue([makeBlockedMatch('alpha')]);
      const { service } = makeServiceFromFakes(deps);

      // Act
      const summary = await service.rescore([makePortfolioEntry({ domain: 'alpha.com' })]);

      // Assert
      const r = summary.results[0]!;
      expect(r.trademarkVerdict).toBe(GateVerdict.Blocked);
      expect(r.trademarkClear).toBe(false);
      expect(r.matchedMark).toBe('alpha');
    });

    it('reports Unverified when every TM provider errors', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      vi.mocked(deps.uspto.search).mockRejectedValue(new Error('upstream 503'));
      vi.mocked(deps.euipo.search).mockRejectedValue(new Error('upstream 503'));
      const { service } = makeServiceFromFakes(deps);

      // Act
      const summary = await service.rescore([makePortfolioEntry({ domain: 'alpha.com' })]);

      // Assert
      const r = summary.results[0]!;
      expect(r.trademarkVerdict).toBe(GateVerdict.Unverified);
      expect(r.trademarkClear).toBe(false);
      expect(r.verifiedSources).toEqual([]);
    });
  });

  describe('error containment', () => {
    it('captures a per-domain error when scoring throws, without aborting the batch', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      // The keyword provider is async — make the second call fail
      // so the second entry errors but the first succeeds.
      let calls = 0;
      vi.mocked(deps.keyword.getMetrics).mockImplementation((term) => {
        calls++;
        if (calls === 2) return Promise.reject(new Error('keyword provider down'));
        return Promise.resolve({ term, monthlySearchVolume: 0, cpc: 0, competition: 0 });
      });
      const { service } = makeServiceFromFakes(deps);

      // Act
      const summary = await service.rescore([
        makePortfolioEntry({ domain: 'alpha.com' }),
        makePortfolioEntry({ domain: 'beta.io', tld: '.io' }),
      ]);

      // Assert
      expect(summary.results).toHaveLength(2);
      expect(summary.results[0]?.error).toBeUndefined();
      expect(summary.results[1]?.error).toContain('keyword provider down');
      expect(summary.results[1]?.calibratedScore).toBe(0);
      expect(summary.results[1]?.trademarkVerdict).toBe(GateVerdict.Unverified);
    });
  });

  describe('scoring_runs persistence (ADR-0010 errata)', () => {
    it('creates a synthetic candidate and writes a scoring_runs row per entry', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      const { service } = makeServiceFromFakes(deps);

      // Act
      await service.rescore([
        makePortfolioEntry({ domain: 'alpha.com' }),
        makePortfolioEntry({ domain: 'beta.io', tld: '.io' }),
      ]);

      // Assert
      const candidateCount = db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE source = ?').get('portfolio_rescore') as { n: number };
      expect(candidateCount.n).toBe(2);
      const scoreCount = db.prepare('SELECT COUNT(*) AS n FROM scoring_runs WHERE run_id LIKE ?').get('portfolio-rescore-%') as { n: number };
      expect(scoreCount.n).toBe(2);
    });

    it('reuses an existing candidate row instead of duplicating', async () => {
      // Arrange
      const deps = makeFakeRescoreDeps(db);
      const { service } = makeServiceFromFakes(deps);
      db.prepare('INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id) VALUES (?, ?, ?, ?, 0, ?)').run('alpha.com', '.com', 'keyword_combo', 'scored', 'pre-existing');

      // Act
      await service.rescore([makePortfolioEntry({ domain: 'alpha.com' })]);

      // Assert
      const alphaCount = db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE domain = ?').get('alpha.com') as { n: number };
      expect(alphaCount.n).toBe(1);
    });
  });

  describe('runtime isolation (regression: vitest-in-prod)', () => {
    it('production module source does not import from vitest', async () => {
      // Arrange — read the source on disk and confirm there is no
      // `from 'vitest'` import in the runtime module. The test fails
      // the moment a future change drags vitest back into the
      // production graph (which would crash `npm install --omit=dev`).
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const source = readFileSync(resolve(here, '../portfolio-rescore-service.ts'), 'utf-8');

      // Assert
      expect(source).not.toMatch(/from\s+['"]vitest['"]/);
      expect(source).not.toMatch(/require\(['"]vitest['"]\)/);
    });
  });
});
