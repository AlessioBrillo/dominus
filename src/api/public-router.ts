// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import type {
  AnonScoringService,
  AnonTrademarkInfo,
  CompareResult,
  PublicScoreData,
  ValuateScore,
} from '../services/anon-scoring-service.js';
import { isValidDomain } from '../utils/domain.js';
import { runWithTenant } from '../utils/tenant-context.js';
import { getLogger } from '../logger.js';
import type { RedisClient } from '../providers/redis/redis-client.js';
import { generateOgPng } from './open-graph.js';
import { createDomainRateLimiter } from './rate-limits/domain-rate-limiter.js';
import { RedisRateLimitStore } from './middleware/redis-rate-limit-store.js';
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

const SITEMAP_CACHE_TTL_MS = 60 * 60 * 1000;
const SITEMAP_CACHE_MAX_ORIGINS = 32;
const VALUATE_CACHE_MAX_AGE_SECONDS = 300;

interface SitemapCacheEntry {
  xml: string;
  etag: string;
  expiresAt: number;
}

export interface PublicRouterOptions {
  /**
   * Absolute base URL of the public site (e.g. 'https://dominus.app').
   * Used as the origin for canonical URLs, Open Graph metadata, JSON-LD,
   * and the robots.txt Sitemap directive. When unset, the request origin
   * (protocol + Host header, honoring TRUST_PROXY_DEPTH) is used, which
   * is correct for self-hosted deployments behind a reverse proxy.
   */
  publicAppUrl?: string;
  /**
   * Hostnames that can become the public origin when publicAppUrl is
   * unset. Any Host header outside this list is replaced with the first
   * allowed host, so attackers cannot poison canonical/OG/sitemap URLs via
   * Host-Header-derived /cacheable responses (see ADR-0030, C3 hardening).
   */
  allowedHosts?: string[];
  /**
   * Per-IP rate-limit overrides for the public namespace. Any of these
   * unset falls back to the compiled-in defaults (see config.ts). The full
   * set is wired from PUBLIC_RATE_LIMIT_* / PER_DOMAIN_RATE_LIMIT_* /
   * POST_RATE_LIMIT_* / POST_BODY_MAX_BYTES by the composition root.
   */
  rateLimits?: {
    publicWindowMs?: number;
    publicMax?: number;
    perDomainWindowMs?: number;
    perDomainMax?: number;
    postWindowMs?: number;
    postMax?: number;
    postBodyMaxBytes?: number;
  };
}

/** Extract the public-facing origin so per-origin caches key correctly. */
function requestOrigin(req: Request): string {
  return `${req.protocol}://${(req.get('host') ?? '').toLowerCase()}`;
}

/** Resolve the canonical site origin: configured URL wins, else request origin. */
function siteUrlFor(req: Request, options: PublicRouterOptions): string {
  if (options.publicAppUrl) {
    return options.publicAppUrl.endsWith('/')
      ? options.publicAppUrl.slice(0, -1)
      : options.publicAppUrl;
  }

  const host = (req.get('host') ?? '').toLowerCase();
  if (options.allowedHosts?.length && !options.allowedHosts.some((h) => h.toLowerCase() === host)) {
    logger.warn(
      { host, allowed: options.allowedHosts },
      'Host header not in PUBLIC_ALLOWED_HOSTS — pinning canonical origin to the configured host',
    );
    return `https://${options.allowedHosts[0]}`;
  }

  return requestOrigin(req);
}

/**
 * Serve a dynamic robots.txt whose Sitemap directive points at the
 * configured (or request-derived) origin so self-hosted installs
 * reference their own domain, never the managed Cloud one.
 */
export function createRobotsTxtHandler(options: PublicRouterOptions = {}): RequestHandler {
  return (req: Request, res: Response): void => {
    const siteUrl = siteUrlFor(req, options);
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain');
    res.send(`User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/public/sitemap.xml\n`);
  };
}

/**
 * Defense-in-depth: strip the buy signal (suggestedBuyMax) from any public
 * response whose trademark verdict is not 'clear'. The service layer already
 * sanitizes at write and read time; this boundary guard keeps the router
 * conservative even if a caller injects an unsanitized score.
 */
function sanitizePublicScore(
  score: ValuateScore,
  trademark: AnonTrademarkInfo | null | undefined,
): ValuateScore {
  return trademark?.verdict === 'clear' ? score : { ...score, suggestedBuyMax: undefined };
}

function scoreResponseData(data: PublicScoreData): object {
  return {
    slug: data.slug,
    domain: data.domain,
    score: sanitizePublicScore(data.score, data.trademark),
    trademark: data.trademark,
    viewCount: data.viewCount,
    createdAt: data.createdAt,
  };
}

export function createPublicRouter(
  anonScoring: AnonScoringService,
  redisClient?: RedisClient,
  options: PublicRouterOptions = {},
): Router {
  const router = Router();
  const sitemapByOrigin = new Map<string, SitemapCacheEntry>();
  const siteUrlForReq = (req: Request): string => siteUrlFor(req, options);

  const publicWindowMs = options.rateLimits?.publicWindowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const publicMax = options.rateLimits?.publicMax ?? PUBLIC_RATE_LIMIT_MAX;
  const perDomainWindowMs =
    options.rateLimits?.perDomainWindowMs ?? PER_DOMAIN_RATE_LIMIT_WINDOW_MS;
  const perDomainMax = options.rateLimits?.perDomainMax ?? PER_DOMAIN_RATE_LIMIT_MAX;
  const postWindowMs = options.rateLimits?.postWindowMs ?? POST_RATE_LIMIT_WINDOW_MS;
  const postMax = options.rateLimits?.postMax ?? POST_RATE_LIMIT_MAX;
  const postBodyMaxBytes = options.rateLimits?.postBodyMaxBytes ?? POST_BODY_MAX_BYTES;

  const domainRateLimiter = createDomainRateLimiter(
    {
      windowMs: perDomainWindowMs,
      max: perDomainMax,
    },
    redisClient,
  );

  const sharedStore: Store | undefined =
    redisClient?.isConnected === true
      ? new RedisRateLimitStore(redisClient, publicWindowMs)
      : undefined;

  const publicRateLimiter = rateLimit({
    windowMs: publicWindowMs,
    max: publicMax,
    standardHeaders: true,
    legacyHeaders: false,
    ...(sharedStore === undefined ? {} : { store: sharedStore }),
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
  });

  const postRateLimiter = rateLimit({
    windowMs: postWindowMs,
    max: postMax,
    standardHeaders: true,
    legacyHeaders: false,
    ...(sharedStore === undefined ? {} : { store: sharedStore }),
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many score requests for your IP. Please wait before creating more.',
      },
    },
  });

  router.use(publicRateLimiter);

  router.use((_req, _res, next) => runWithTenant('public', () => next()));

  router.get('/robots.txt', createRobotsTxtHandler(options));

  router.post(
    '/scores',
    postRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rawBody = typeof req.body === 'object' && req.body !== null ? req.body : {};
        const bodyStr = JSON.stringify(rawBody);
        if (bodyStr.length > postBodyMaxBytes) {
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
        if (!(await domainRateLimiter.check(ip, domain))) {
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

        const result = await anonScoring.valuate(domain);
        if (req.accepts('html')) {
          res.set('Cache-Control', 'public, max-age=86400');
          res.send(
            renderDomainPage(result.domain, result.score, result.trademark, siteUrlForReq(req)),
          );
        } else {
          res.set('Cache-Control', `public, max-age=${VALUATE_CACHE_MAX_AGE_SECONDS}`);
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
              {
                ...result.score1,
                score: sanitizePublicScore(result.score1.score, result.score1.trademark),
              },
              result.score2.domain,
              {
                ...result.score2,
                score: sanitizePublicScore(result.score2.score, result.score2.trademark),
              },
              siteUrlForReq(req),
            ),
          );
        } else {
          res.json({
            score1: {
              ...result.score1,
              score: sanitizePublicScore(result.score1.score, result.score1.trademark),
            },
            score2: {
              ...result.score2,
              score: sanitizePublicScore(result.score2.score, result.score2.trademark),
            },
          });
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
        const origin = siteUrlForReq(req);
        const cached = sitemapByOrigin.get(origin);
        const now = Date.now();

        if (cached !== undefined && cached.expiresAt > now) {
          if (req.headers['if-none-match'] === cached.etag) {
            res.status(304).end();
            return;
          }
          res.set('ETag', cached.etag);
          res.set('Cache-Control', 'public, max-age=3600');
          res.type('application/xml');
          res.send(cached.xml);
          return;
        }

        const rows = await anonScoring.listRecentScores(90, 50000);
        const urls = rows
          .map((r) => {
            const lastmod = r.created_at
              ? new Date(r.created_at).toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0];
            const encodedSlug = escapeHtml(r.slug);
            return `
  <url>
    <loc>${escapeHtml(origin)}/public/s/${encodedSlug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
    <image:image>
      <image:loc>${escapeHtml(origin)}/public/s/${encodedSlug}/og.png</image:loc>
      <image:title>${escapeHtml(r.domain)} — DOMINUS Score</image:title>
    </image:image>
  </url>`;
          })
          .join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls}
</urlset>`;

        const etag = `"${createHash('sha1').update(xml).digest('hex')}"`;
        if (sitemapByOrigin.size >= SITEMAP_CACHE_MAX_ORIGINS) {
          const oldest = sitemapByOrigin.keys().next().value as string | undefined;
          if (oldest !== undefined) sitemapByOrigin.delete(oldest);
        }
        sitemapByOrigin.set(origin, { xml, etag, expiresAt: now + SITEMAP_CACHE_TTL_MS });

        res.set('ETag', etag);
        res.set('Cache-Control', 'public, max-age=3600');
        res.type('application/xml');
        res.send(xml);
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

      const safeData = {
        ...data,
        score: sanitizePublicScore(data.score, data.trademark),
        viewCount: data.viewCount + 1,
      };

      if (req.accepts('html')) {
        const ogImageUrl = `/public/s/${slug}/og.png`;
        res.set('Cache-Control', 'public, max-age=3600');
        res.set('Link', `<${ogImageUrl}>; rel=preload; as=image`);
        res.send(
          renderScorePage(
            {
              slug: safeData.slug,
              domain: safeData.domain,
              score: safeData.score,
              trademark: safeData.trademark,
              viewCount: safeData.viewCount,
              createdAt: safeData.createdAt,
            },
            siteUrlForReq(req),
          ),
        );
      } else {
        res.json(scoreResponseData(safeData));
      }
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
