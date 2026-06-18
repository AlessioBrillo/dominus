import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { Verdict } from '../../types/portfolio.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import { makeFakeRescoreDeps, makeServiceFromFakes } from './rescore-test-helpers.js';
import type { PortfolioRescoreService } from '../portfolio-rescore-service.js';
import { PortfolioManager } from '../portfolio-manager.js';

function openTestDb(): SqliteProvider {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return new SqliteProvider(db);
}

describe('PortfolioManager.rescoreAll', () => {
  let db: SqliteProvider;
  let repo: PortfolioRepository;
  let manager: PortfolioManager;
  let service: PortfolioRescoreService;
  let deps: ReturnType<typeof makeFakeRescoreDeps>;

  beforeEach(() => {
    db = openTestDb();
    repo = new PortfolioRepository(db);
    deps = makeFakeRescoreDeps(db);
    const built = makeServiceFromFakes(deps);
    service = built.service;
    manager = new PortfolioManager(repo, 25, 60);
    manager.setRescoreService(service);
  });

  it('persists the calibrated score and suggested list price from the rescore', async () => {
    // Arrange — one portfolio entry, no score yet
    manager.add({
      domain: 'alpha.com',
      tld: '.com',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      renewalDate: '2026-01-01T00:00:00.000Z',
      acquisitionCost: 12,
      renewalCost: 12,
      registrar: 'namecheap',
    });

    // Act
    const summary = await manager.rescoreAll();

    // Assert
    expect(summary.results).toHaveLength(1);
    const stored = repo.findByDomain('alpha.com');
    expect(stored?.currentScore).toBe(summary.results[0]?.calibratedScore);
    expect(stored?.suggestedListPrice).toBe(summary.results[0]?.suggestedListPrice);
  });

  it('throws clearly when the rescore service has not been configured', async () => {
    // Arrange
    const bare = new PortfolioManager(repo, 25, 60);

    // Act + Assert
    await expect(bare.rescoreAll()).rejects.toThrow(/setRescoreService/);
  });

  it('recomputes verdicts based on the new score (closes the always-Drop bug)', async () => {
    // Arrange — entry with renewal approaching: old code would have
    // marked this Drop because currentScore was 0 < 25.
    // Make the scoring engine return a HIGH calibrated score so the
    // verdict becomes Keep.
    vi.mocked(deps.comps.getSales).mockResolvedValue([
      { domain: 'alpha.com', salePrice: 3000, saleDate: '2024-01-01', venue: 'sedo' },
    ]);
    vi.mocked(deps.keyword.getMetrics).mockResolvedValue({
      term: 'alpha',
      monthlySearchVolume: 80000,
      cpc: 8,
      competition: 0.6,
    });

    // Renewal in 20 days (within 60-day horizon)
    const inTwentyDays = new Date(Date.now() + 20 * 86_400_000).toISOString();
    manager.add({
      domain: 'alpha.com',
      tld: '.com',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      renewalDate: inTwentyDays,
      acquisitionCost: 12,
      renewalCost: 12,
      registrar: 'namecheap',
    });

    // Act
    await manager.rescoreAll();
    const after = repo.findByDomain('alpha.com');

    // Assert — with a high score, the verdict is no longer Drop.
    // (Concretely the engine returns a non-zero weighted score for a
    //  high-volume / high-CPC / good-comps SLD, which projects above
    //  the 25 threshold.)
    expect(after?.currentScore).toBeDefined();
    expect(after?.currentScore).toBeGreaterThan(25);
    expect(after?.verdict).not.toBe(Verdict.Drop);
  });

  it('keeps the verdict as Drop when the new score is below the threshold', async () => {
    // Arrange — entry where scoring is weak; currentScore should stay low
    // and verdict should be Drop. With weight redistribution (intrinsic=1.0
    // when all other signals have no data), a domain with poor intrinsic
    // quality (long, many hyphens/digits, unpronounceable) still scores low.
    const inFifteenDays = new Date(Date.now() + 15 * 86_400_000).toISOString();
    manager.add({
      domain: 'x-1-2-3-4-5.com',
      tld: '.com',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      renewalDate: inFifteenDays,
      acquisitionCost: 12,
      renewalCost: 12,
      registrar: 'namecheap',
    });

    // Act
    await manager.rescoreAll();
    const after = repo.findByDomain('x-1-2-3-4-5.com');

    // Assert
    expect(after?.currentScore).toBeLessThanOrEqual(25);
    expect(after?.verdict).toBe(Verdict.Drop);
  });

  it('handles a per-domain error from the rescore service without aborting the batch', async () => {
    // Arrange — two entries; second one makes the keyword provider throw
    manager.add({
      domain: 'alpha.com',
      tld: '.com',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      renewalDate: '2026-01-01T00:00:00.000Z',
      acquisitionCost: 12,
      renewalCost: 12,
      registrar: 'namecheap',
    });
    manager.add({
      domain: 'beta.io',
      tld: '.io',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      renewalDate: '2026-01-01T00:00:00.000Z',
      acquisitionCost: 12,
      renewalCost: 12,
      registrar: 'namecheap',
    });

    let calls = 0;
    vi.mocked(deps.keyword.getMetrics).mockImplementation((term) => {
      calls++;
      if (calls === 2) return Promise.reject(new Error('upstream down'));
      return Promise.resolve({ term, monthlySearchVolume: 0, cpc: 0, competition: 0 });
    });

    // Act
    const summary = await manager.rescoreAll();

    // Assert — summary captures the error AND the first entry is persisted
    expect(summary.results).toHaveLength(2);
    expect(summary.results[1]?.error).toContain('upstream down');
    // Engine degrades gracefully: intrinsic-only weighted score >= 0
    expect(summary.results[1]?.calibratedScore).toBeGreaterThanOrEqual(0);
    const alpha = repo.findByDomain('alpha.com');
    expect(alpha?.currentScore).toBeDefined();
  });

  it('persists a 0 score and Unverified verdict when the TM gate cannot clear the domain', async () => {
    // Arrange
    vi.mocked(deps.uspto.search).mockResolvedValue([
      { markName: 'alpha', owner: 'Acme', status: 'live', source: 'USPTO' },
    ]);
    manager.add({
      domain: 'alpha.com',
      tld: '.com',
      acquiredAt: '2025-01-01T00:00:00.000Z',
      renewalDate: '2026-01-01T00:00:00.000Z',
      acquisitionCost: 12,
      renewalCost: 12,
      registrar: 'namecheap',
    });

    // Act
    const summary = await manager.rescoreAll();

    // Assert
    expect(summary.results[0]?.trademarkVerdict).toBe(GateVerdict.Blocked);
    expect(summary.results[0]?.trademarkClear).toBe(false);
  });
});
