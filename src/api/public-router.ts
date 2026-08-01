// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import type {
  AnonScoringService,
  CompareResult,
  PublicScoreData,
} from '../services/anon-scoring-service.js';
import { isValidDomain } from '../utils/domain.js';
import { runWithTenant } from '../utils/tenant-context.js';
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

function createPerDomainRateLimiter(): {
  check: (ip: string, domain: string) => boolean;
} {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const MAX_WINDOWS = 10_000;
  let pruneWarningLogged = false;

  function key(ip: string, domain: string): string {
    return `${ip}:${domain.toLowerCase()}`;
  }

  function prune(now: number): void {
    for (const [k, v] of windows) {
      if (now > v.resetAt) windows.delete(k);
    }
  }

  return {
    check(ip: string, domain: string): boolean {
      const k = key(ip, domain);
      const now = Date.now();
      prune(now);

      let entry = windows.get(k);
      if (!entry || now > entry.resetAt) {
        if (windows.size >= MAX_WINDOWS) {
          if (!pruneWarningLogged) {
            logger.warn(
              {
                maxWindows: MAX_WINDOWS,
                currentSize: windows.size,
              },
              'Per-domain rate limiter at capacity — evicting oldest entry',
            );
            pruneWarningLogged = true;
          }
          const oldest = windows.keys().next();
          if (!oldest.done && oldest.value !== undefined) {
            windows.delete(oldest.value);
          }
        }
        windows.set(k, { count: 1, resetAt: now + PER_DOMAIN_RATE_LIMIT_WINDOW_MS });
        return true;
      }
      entry.count++;
      return entry.count <= PER_DOMAIN_RATE_LIMIT_MAX;
    },
  };
}

function scoreResponseData(data: PublicScoreData): object {
  return {
    slug: data.slug,
    domain: data.domain,
    score: data.score,
    trademark: data.trademark,
    viewCount: data.viewCount,
    createdAt: data.createdAt,
  };
}

export function createPublicRouter(anonScoring: AnonScoringService): Router {
  const router = Router();
  const domainRateLimiter = createPerDomainRateLimiter();

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

        const result = await anonScoring.createScore(domain);
        logger.info({ slug: result.slug, domain }, 'Public score created');
        res.status(201).json(result);
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

        const result = await anonScoring.score(domain);
        if (req.accepts('html')) {
          res.set('Cache-Control', 'public, max-age=86400');
          res.send(renderDomainPage(result.domain, result.score, result.trademark));
        } else {
          res.json(result);
        }
      } catch (err: unknown) {
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

        const result: CompareResult | null = await anonScoring.getCompareScores(slug1, slug2);

        if (!result) {
          if (req.accepts('html')) {
            res.status(404).send(renderErrorPage('One or both scores not found'));
          } else {
            res
              .status(404)
              .json({ error: { code: 'NOT_FOUND', message: 'One or both scores not found' } });
          }
          return;
        }

        anonScoring.bumpViewCount(slug1);
        anonScoring.bumpViewCount(slug2);

        if (req.accepts('html')) {
          res.set('Cache-Control', 'public, max-age=600');
          res.send(
            renderComparePage(
              result.score1.domain,
              result.score1,
              result.score2.domain,
              result.score2,
            ),
          );
        } else {
          res.json(result);
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
        const rows = await anonScoring.listRecentScores(90, 50000);

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

        res.set('Cache-Control', 'public, max-age=3600');
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

        const row = await anonScoring.findForOgImage(slugOg);

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

      const data = await anonScoring.getScoreBySlug(slug);

      if (!data) {
        if (req.accepts('html')) {
          res.status(404).send(renderErrorPage('Score not found'));
        } else {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Score not found' },
          });
        }
        return;
      }

      anonScoring.bumpViewCount(slug);

      const responseData = scoreResponseData({
        ...data,
        viewCount: data.viewCount + 1,
      });

      if (req.accepts('html')) {
        const ogImageUrl = `/public/s/${slug}/og.png`;
        res.set('Cache-Control', 'public, max-age=3600');
        res.set('Link', `<${ogImageUrl}>; rel=preload; as=image`);
        res.send(
          renderScorePage({
            slug: data.slug,
            domain: data.domain,
            score: data.score,
            trademark: data.trademark,
            viewCount: data.viewCount + 1,
            createdAt: data.createdAt,
          }),
        );
      } else {
        res.json(responseData);
      }
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
