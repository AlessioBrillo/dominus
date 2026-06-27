import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from '../db/provider/interface.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import { type AnonScoringService, DomainValidationError } from '../services/anon-scoring-service.js';
import { isValidDomain, parseDomain } from '../utils/domain.js';
import { getLogger } from '../logger.js';
import { generateOgPng } from './open-graph.js';
import {
  escapeHtml,
  renderScorePage,
  renderDomainPage,
  renderComparePage,
  renderErrorPage,
} from './views/index.js';

const logger = getLogger();

const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000;
const PUBLIC_RATE_LIMIT_MAX = 30;

const CACHE_TTL_MS = 300_000; // 5 minutes

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

function createCache(): {
  get: (key: string) => unknown | undefined;
  set: (key: string, data: unknown) => void;
} {
  const store = new Map<string, CacheEntry>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function get(key: string): unknown | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  function set(key: string, data: unknown): void {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    store.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    timers.set(
      key,
      setTimeout(() => {
        store.delete(key);
        timers.delete(key);
      }, CACHE_TTL_MS).unref(),
    );
  }

  return { get, set };
}

export function createPublicRouter(
  db: DatabaseProvider,
  engine: ScoringEngine,
  trademarkGate?: TrademarkGate,
  anonScoring?: AnonScoringService,
): Router {
  const router = Router();
  const cache = createCache();

  const publicRateLimiter = rateLimit({
    windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
    max: PUBLIC_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
  });

  router.use(publicRateLimiter);

  router.post('/scores', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { domain } = req.body as { domain?: string };
      if (!domain || !isValidDomain(domain)) {
        res.status(400).json({
          error: { code: 'INVALID_DOMAIN', message: `'${domain ?? ''}' is not a valid domain` },
        });
        return;
      }

      const parsed = parseDomain(domain);
      const scoreResult = await engine.score({
        domain,
        tld: parsed.tld,
        sld: parsed.sld,
        isCloseout: false,
      });

      let trademarkJson: string | null = null;
      if (trademarkGate) {
        try {
          const gateResult = await trademarkGate.check(domain);
          trademarkJson = JSON.stringify({
            verdict: gateResult.verdict,
            verifiedSources: gateResult.verifiedSources,
            matchedMark: gateResult.matchedMark ?? null,
            matchedOwner: gateResult.matchedOwner ?? null,
          });
        } catch {
          trademarkJson = JSON.stringify({ verdict: 'unverified', verifiedSources: [] });
        }
      }

      const slug = randomUUID().replace(/-/g, '').slice(0, 12);
      const scoreJson = JSON.stringify(scoreResult);

      await db.exec(
        'INSERT INTO public_scores (slug, domain, score_json, trademark_json) VALUES (?, ?, ?, ?)',
        [slug, domain, scoreJson, trademarkJson],
      );

      logger.info({ slug, domain }, 'Public score created');

      res.status(201).json({
        slug,
        url: `/public/s/${slug}`,
        domain,
      });
    } catch (err: unknown) {
      next(err);
    }
  });

  router.get(
    '/domain/:domain',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const domain = req.params.domain as string | undefined;
        if (!domain || !isValidDomain(domain)) {
          if (req.accepts('html')) {
            res.status(400).send(renderErrorPage('Invalid domain'));
          } else {
            res.status(400).json({
              error: { code: 'INVALID_DOMAIN', message: `'${domain ?? ''}' is not a valid domain` },
            });
          }
          return;
        }

        if (anonScoring) {
          const result = await anonScoring.score(domain);
          if (req.accepts('html')) {
            res.send(renderDomainPage(result.domain, result.score, result.trademark));
          } else {
            res.json(result);
          }
          return;
        }

        // Fallback when AnonScoringService not available — score inline
        const parsed = parseDomain(domain);

        let trademarkResult: {
          verdict: string;
          verifiedSources: string[];
          matchedMark?: string | null;
        } | null = null;
        if (trademarkGate) {
          try {
            const gateResult = await trademarkGate.check(domain);
            trademarkResult = {
              verdict: gateResult.verdict,
              verifiedSources: gateResult.verifiedSources,
              matchedMark: gateResult.matchedMark ?? null,
            };
          } catch {
            trademarkResult = { verdict: 'unverified', verifiedSources: [] };
          }
        }

        const scoreResult = await engine.score({
          domain,
          tld: parsed.tld,
          sld: parsed.sld,
          isCloseout: false,
        });

        const data = { domain, score: scoreResult, trademark: trademarkResult };
        cache.set(`domain:${domain.toLowerCase()}`, data);

        logger.info(
          { domain, trademarkVerdict: trademarkResult?.verdict },
          'Public domain score served',
        );

        if (req.accepts('html')) {
          res.send(renderDomainPage(domain, scoreResult, trademarkResult));
        } else {
          res.json(data);
        }
      } catch (err: unknown) {
        if (err instanceof DomainValidationError) {
          res.status(400).json({
            error: { code: 'INVALID_DOMAIN', message: err.message },
          });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    '/compare/:slug1/:slug2',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { slug1, slug2 } = req.params;
        if (!slug1 || slug1.length < 8 || !slug2 || slug2.length < 8) {
          if (req.accepts('html')) {
            res.status(400).send(renderErrorPage('Invalid score slugs'));
          } else {
            res
              .status(400)
              .json({ error: { code: 'INVALID_SLUG', message: 'Invalid score slugs' } });
          }
          return;
        }

        const cached = cache.get(`compare:${slug1}:${slug2}`);
        if (cached && !req.accepts('html')) {
          res.json(cached);
          return;
        }

        const row1 = await db.queryOne<{
          slug: string;
          domain: string;
          score_json: string;
          trademark_json: string | null;
          view_count: number;
          created_at: string;
        }>(
          'SELECT slug, domain, score_json, trademark_json, view_count, created_at FROM public_scores WHERE slug = ?',
          [slug1],
        );
        const row2 = row1
          ? await db.queryOne<typeof row1>(
              'SELECT slug, domain, score_json, trademark_json, view_count, created_at FROM public_scores WHERE slug = ?',
              [slug2],
            )
          : undefined;

        if (!row1 || !row2) {
          if (req.accepts('html')) {
            res.status(404).send(renderErrorPage('One or both scores not found'));
          } else {
            res
              .status(404)
              .json({ error: { code: 'NOT_FOUND', message: 'One or both scores not found' } });
          }
          return;
        }

        const score1 = {
          domain: row1.domain,
          score: JSON.parse(row1.score_json),
          trademark: row1.trademark_json ? JSON.parse(row1.trademark_json) : null,
        };
        const score2 = {
          domain: row2.domain,
          score: JSON.parse(row2.score_json),
          trademark: row2.trademark_json ? JSON.parse(row2.trademark_json) : null,
        };

        await db.exec('UPDATE public_scores SET view_count = view_count + 1 WHERE slug = ?', [
          slug1,
        ]);
        await db.exec('UPDATE public_scores SET view_count = view_count + 1 WHERE slug = ?', [
          slug2,
        ]);

        const data = { score1, score2 };
        cache.set(`compare:${slug1}:${slug2}`, data);

        if (req.accepts('html')) {
          res.send(renderComparePage(score1.domain, score1, score2.domain, score2));
        } else {
          res.json(data);
        }
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  router.get(
    '/sitemap.xml',
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      try {
        const rows = await db.query<{
          slug: string;
          domain: string;
          created_at: string;
        }>('SELECT slug, domain, created_at FROM public_scores ORDER BY created_at DESC');

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const urls = rows
          .map((r) => {
            const lastmod = r.created_at
              ? new Date(r.created_at).toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0];
            return `
  <url>
    <loc>${escapeHtml(baseUrl)}/public/s/${escapeHtml(r.slug)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`;
          })
          .join('');

        res.type('application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`);
      } catch (err: unknown) {
        logger.error({ err }, 'Failed to generate sitemap');
        res.status(500).send('Internal server error');
      }
    },
  );

  router.get(
    '/s/:slug/og.png',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { slug } = req.params;
        if (!slug || slug.length < 8) {
          res.status(400).json({
            error: { code: 'INVALID_SLUG', message: 'Invalid score slug' },
          });
          return;
        }

        const row = await db.queryOne<{
          slug: string;
          domain: string;
          score_json: string;
          trademark_json: string | null;
        }>('SELECT slug, domain, score_json, trademark_json FROM public_scores WHERE slug = ?', [
          slug,
        ]);

        if (!row) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Score not found' },
          });
          return;
        }

        const score = JSON.parse(row.score_json);
        const trademark = row.trademark_json
          ? (JSON.parse(row.trademark_json) as { verdict: string })
          : { verdict: 'unverified' };

        const png = await generateOgPng(row.domain, {
          domain: row.domain,
          expectedValue: score.expectedValue ?? 0,
          confidence: score.confidence ?? 0,
          weightedScore: score.weightedScore ?? 0,
          recommended: score.recommended ?? false,
          trademark: trademark.verdict ?? 'unverified',
        });

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
        res.setHeader('ETag', `"og-${row.domain.toLowerCase().replace(/[^a-z0-9]/g, '-')}"`);
        res.status(200).end(png);
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  router.get('/s/:slug', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { slug } = req.params;
      if (!slug || slug.length < 8) {
        res.status(400).json({
          error: { code: 'INVALID_SLUG', message: 'Invalid score slug' },
        });
        return;
      }

      const cached = cache.get(`score:${slug}`);
      if (cached && !req.accepts('html')) {
        await db.exec('UPDATE public_scores SET view_count = view_count + 1 WHERE slug = ?', [
          slug,
        ]);
        res.json(cached);
        return;
      }

      const row = await db.queryOne<{
        slug: string;
        domain: string;
        score_json: string;
        trademark_json: string | null;
        view_count: number;
        created_at: string;
      }>(
        'SELECT slug, domain, score_json, trademark_json, view_count, created_at FROM public_scores WHERE slug = ?',
        [slug],
      );

      if (!row) {
        if (req.accepts('html')) {
          res.status(404).send(renderErrorPage('Score not found'));
        } else {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Score not found' },
          });
        }
        return;
      }

      const score = JSON.parse(row.score_json);
      const trademark = row.trademark_json ? JSON.parse(row.trademark_json) : null;
      const viewCount = row.view_count + 1;

      await db.exec('UPDATE public_scores SET view_count = view_count + 1 WHERE slug = ?', [slug]);

      const data = {
        slug: row.slug,
        domain: row.domain,
        score,
        trademark,
        viewCount,
        createdAt: row.created_at,
      };

      cache.set(`score:${slug}`, data);

      if (req.accepts('html')) {
        res.send(renderScorePage(data));
      } else {
        res.json(data);
      }
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
