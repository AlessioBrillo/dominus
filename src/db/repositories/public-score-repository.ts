// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';

export interface PublicScoreRow {
  slug: string;
  domain: string;
  score_json: string;
  trademark_json: string | null;
  view_count: number;
  created_at: string;
}

export interface PublicScoreCompareResult {
  row1: PublicScoreRow | null;
  row2: PublicScoreRow | null;
}

export interface PublicScoreSitemapRow {
  slug: string;
  domain: string;
  created_at: string;
}

export interface PublicScoreOgRow {
  slug: string;
  domain: string;
  score_json: string;
  trademark_json: string | null;
}

const ALL_COLUMNS = 'slug, domain, score_json, trademark_json, view_count, created_at';

const OGS_COLUMNS = 'slug, domain, score_json, trademark_json';

export class PublicScoreRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async insert(
    slug: string,
    domain: string,
    scoreJson: string,
    trademarkJson: string | null,
  ): Promise<void> {
    await this.db.exec(
      'INSERT INTO public_scores (slug, domain, score_json, trademark_json) VALUES (?, ?, ?, ?)',
      [slug, domain, scoreJson, trademarkJson],
    );
  }

  async findBySlug(slug: string): Promise<PublicScoreRow | null> {
    return this.db.queryOne<PublicScoreRow>(
      `SELECT ${ALL_COLUMNS} FROM public_scores WHERE slug = ?`,
      [slug],
    );
  }

  async findBySlugsForCompare(slug1: string, slug2: string): Promise<PublicScoreCompareResult> {
    const row1 = await this.findBySlug(slug1);
    const row2 = row1 ? await this.findBySlug(slug2) : null;
    return { row1, row2 };
  }

  async updateViewCount(slug: string, delta: number): Promise<void> {
    await this.db.exec('UPDATE public_scores SET view_count = view_count + ? WHERE slug = ?', [
      delta,
      slug,
    ]);
  }

  async listRecentScores(days: number, limit: number): Promise<PublicScoreSitemapRow[]> {
    return this.db.query<PublicScoreSitemapRow>(
      `SELECT slug, domain, created_at FROM public_scores WHERE created_at > datetime('now', ? || ' days') ORDER BY created_at DESC LIMIT ?`,
      [`-${days}`, limit],
    );
  }

  async pruneOlderThan(days: number): Promise<number> {
    const result = await this.db.exec('DELETE FROM public_scores WHERE created_at < ?', [
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
    ]);
    return Number(result.changes);
  }

  async findForOgImage(slug: string): Promise<PublicScoreOgRow | null> {
    return this.db.queryOne<PublicScoreOgRow>(
      `SELECT ${OGS_COLUMNS} FROM public_scores WHERE slug = ?`,
      [slug],
    );
  }
}
