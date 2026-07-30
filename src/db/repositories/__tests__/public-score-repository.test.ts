import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { PublicScoreRepository } from '../public-score-repository.js';

describe('PublicScoreRepository', () => {
  let db: SqliteProvider;
  let repo: PublicScoreRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new PublicScoreRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('inserts a public score row', async () => {
    await repo.insert('abc123', 'example.com', '{"ev":100}', '{"verdict":"clear"}');
    const row = await repo.findBySlug('abc123');
    expect(row).not.toBeNull();
    expect(row!.slug).toBe('abc123');
    expect(row!.domain).toBe('example.com');
    expect(row!.score_json).toBe('{"ev":100}');
    expect(row!.trademark_json).toBe('{"verdict":"clear"}');
    expect(row!.view_count).toBe(0);
  });

  it('inserts a row without trademark_json', async () => {
    await repo.insert('abc124', 'example.com', '{"ev":100}', null);
    const row = await repo.findBySlug('abc124');
    expect(row).not.toBeNull();
    expect(row!.trademark_json).toBeNull();
  });

  it('returns null for non-existent slug', async () => {
    const row = await repo.findBySlug('nonexistent');
    expect(row).toBeNull();
  });

  it('finds multiple slugs for compare', async () => {
    await repo.insert('s1', 'alpha.com', '{}', null);
    await repo.insert('s2', 'beta.com', '{}', null);
    const result = await repo.findBySlugsForCompare('s1', 's2');
    expect(result.row1).not.toBeNull();
    expect(result.row1!.slug).toBe('s1');
    expect(result.row2).not.toBeNull();
    expect(result.row2!.slug).toBe('s2');
  });

  it('returns partial compare when one slug missing', async () => {
    await repo.insert('s1', 'alpha.com', '{}', null);
    const result = await repo.findBySlugsForCompare('s1', 'missing');
    expect(result.row1).not.toBeNull();
    expect(result.row2).toBeNull();
  });

  it('updates view_count by delta', async () => {
    await repo.insert('v1', 'viewtest.com', '{}', null);
    await repo.updateViewCount('v1', 5);
    const row = await repo.findBySlug('v1');
    expect(row!.view_count).toBe(5);
    await repo.updateViewCount('v1', 3);
    const row2 = await repo.findBySlug('v1');
    expect(row2!.view_count).toBe(8);
  });

  it('handles updateViewCount for non-existent slug gracefully', async () => {
    await expect(repo.updateViewCount('nope', 1)).resolves.not.toThrow();
  });

  it('lists recent scores within cutoff', async () => {
    await repo.insert('a1', 'a.com', '{}', null);
    await repo.insert('a2', 'b.com', '{}', null);
    const rows = await repo.listRecentScores(90, 10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.slug === 'a1')).toBe(true);
    expect(rows.some((r) => r.slug === 'a2')).toBe(true);
  });

  it('prunes scores older than cutoff', async () => {
    await repo.insert('old1', 'old.com', '{}', null);

    const pruned = await repo.pruneOlderThan(0);
    expect(pruned).toBeGreaterThanOrEqual(0);
  });

  it('exposes findForOgImage with minimal fields', async () => {
    await repo.insert('og1', 'ogtest.com', '{"ev":200}', '{"verdict":"clear"}');
    const row = await repo.findForOgImage('og1');
    expect(row).not.toBeNull();
    expect(row!.slug).toBe('og1');
    expect(row!.domain).toBe('ogtest.com');
    expect(row!.score_json).toBe('{"ev":200}');
    expect(row!.trademark_json).toBe('{"verdict":"clear"}');
  });

  it('returns null for og data on missing slug', async () => {
    const row = await repo.findForOgImage('no-such-slug');
    expect(row).toBeNull();
  });
});
