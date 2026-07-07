import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from '../db/provider/interface.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import {
  type AnonScoringService,
  DomainValidationError,
} from '../services/anon-scoring-service.js';
import { isValidDomain, parseDomain } from '../utils/domain.js';
import { runWithTenant } from '../utils/tenant-context.js';
import { MemoryCache } from '../providers/cached-provider.js';
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
const PER_DOMAIN_RATE_LIMIT_WINDOW_MS = 60_000;
const PER_DOMAIN_RATE_LIMIT_MAX = 5;
const POST_RATE_LIMIT_WINDOW_MS = 60_000;
const POST_RATE_LIMIT_MAX = 10;
const POST_BODY_MAX_BYTES = 1000;
const CACHE_MAX_SIZE = 500;
const CACHE_TTL_SECONDS = 300;
const VIEW_COUNT_FLUSH_INTERVAL_MS = 60_000;

interface ViewCountEntry {
  slug: string;
  count: number;
}

function createPerDomainRateLimiter(): {
  check: (ip: string, domain: string) => boolean;
} {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const MAX_WINDOWS = 10_000;

  function key(ip: string, domain: string): string {
    return `${ip}:${domain.toLowerCase()}`;
  }

  function prune(): void {
    const now = Date.now();
    for (const [k, v] of windows) {
      if (now > v.resetAt) windows.delete(k);
    }
  }

  setInterval(prune, 60_000).unref();

  return {
    check(ip: string, domain: string): boolean {
      const k = key(ip, domain);
      const now = Date.now();
      let entry = windows.get(k);
      if (!entry || now > entry.resetAt) {
        if (windows.size >= MAX_WINDOWS && !windows.has(k)) {
          return true;
        }
        windows.set(k, { count: 1, resetAt: now + PER_DOMAIN_RATE_LIMIT_WINDOW_MS });
        return true;
      }
      entry.count++;
      return entry.count <= PER_DOMAIN_RATE_LIMIT_MAX;
    },
  };
}

export function createPublicRouter(
  db: DatabaseProvider,
  engine: ScoringEngine,
  trademarkGate?: TrademarkGate,
  anonScoring?: AnonScoringService,
): Router {
  const router = Router();
  const cache = new MemoryCache<unknown>(CACHE_MAX_SIZE, CACHE_TTL_SECONDS);
  const domainRateLimiter = createPerDomainRateLimiter();

  let viewCountBuffer: ViewCountEntry[] = [];
  let viewCountFlushTimer: ReturnType<typeof setInterval> | null = null;

  function scheduleViewCountFlush(): void {
    if (viewCountFlushTimer) return;
    viewCountFlushTimer = setInterval(async () => {
      const batch = viewCountBuffer;
      viewCountBuffer = [];
      if (batch.length === 0) return;
      for (const entry of batch) {
        await db
          .exec('UPDATE public_scores SET view_count = view_count + ? WHERE slug = ?', [
            entry.count,
            entry.slug,
          ])
          .catch((err: unknown) => {
            logger.warn({ err, slug: entry.slug }, 'Failed to flush view_count');
          });
      }
    }, VIEW_COUNT_FLUSH_INTERVAL_MS).unref();
  }

  function bumpViewCount(slug: string): void {
    scheduleViewCountFlush();
    const existing = viewCountBuffer.find((e) => e.slug === slug);
    if (existing) {
      existing.count++;
    } else {
      viewCountBuffer.push({ slug, count: 1 });
    }
  }

  const publicRateLimiter = rateLimit({
    windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
    max: PUBLIC_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
  });

  const postRateLimiter = rateLimit({
    windowMs: POST_RATE_LIMIT_WINDOW_MS,
    max: POST_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many score requests for your IP. Please wait before creating more.',
      },
    },
  });

  router.use(cors({ origin: '*', methods: ['GET', 'POST', 'HEAD'] }));
  router.use(publicRateLimiter);

  router.use((_req, _res, next) => runWithTenant('public', () => next()));

  router.post(
    '/scores',
    postRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rawBody = typeof req.body === 'object' && req.body !== null ? req.body : {};
        const bodyStr = JSON.stringify(rawBody);
        if (bodyStr.length > POST_BODY_MAX_BYTES) {
          res.status(413).json({
            error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' },
          });
          return;
        }

        const { domain } = rawBody as { domain?: string };
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
    },
  );

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

        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        if (!domainRateLimiter.check(ip, domain)) {
          if (req.accepts('html')) {
            res.status(429).send(renderErrorPage('Too many requests for this domain'));
          } else {
            res.status(429).json({
              error: {
                code: 'RATE_LIMITED',
                message: 'Too many requests for this domain, please try again later',
              },
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
        const slug1 = req.params.slug1 as string | undefined;
        const slug2 = req.params.slug2 as string | undefined;
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
          bumpViewCount(slug1);
          bumpViewCount(slug2);
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

        bumpViewCount(slug1);
        bumpViewCount(slug2);

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
        }>(
          "SELECT slug, domain, created_at FROM public_scores WHERE created_at > datetime('now', '-90 days') ORDER BY created_at DESC LIMIT 50000",
        );

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const urls = rows
          .map((r) => {
            const lastmod = r.created_at
              ? new Date(r.created_at).toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0];
            const encodedSlug = escapeHtml(r.slug);
            return `
  <url>
    <loc>${escapeHtml(baseUrl)}/public/s/${encodedSlug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
    <image:image>
      <image:loc>${escapeHtml(baseUrl)}/public/s/${encodedSlug}/og.png</image:loc>
      <image:title>${escapeHtml(r.domain)} — DOMINUS Score</image:title>
    </image:image>
  </url>`;
          })
          .join('');

        res.type('application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls}
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
        const slugOg = req.params.slug as string | undefined;
        if (!slugOg || slugOg.length < 8) {
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
          slugOg,
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
      const slug = req.params.slug as string | undefined;
      if (!slug || slug.length < 8) {
        res.status(400).json({
          error: { code: 'INVALID_SLUG', message: 'Invalid score slug' },
        });
        return;
      }

      const cached = cache.get(`score:${slug}`);
      if (cached && !req.accepts('html')) {
        bumpViewCount(slug);
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

      bumpViewCount(slug);

      const data = {
        slug: row.slug,
        domain: row.domain,
        score,
        trademark,
        viewCount: row.view_count + 1,
        createdAt: row.created_at,
      };

      cache.set(`score:${slug}`, data);

      if (req.accepts('html')) {
        // Preload the OG image so the browser starts fetching it before
        // parsing the stylesheet — cuts perceived LCP by ~1 round-trip.
        const ogImageUrl = `/public/s/${slug}/og.png`;
        res.set('Link', `<${ogImageUrl}>; rel=preload; as=image`);
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
