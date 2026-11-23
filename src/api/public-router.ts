// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { generateBrandOgPng, generateOgPng } from './open-graph.js';
import { createDomainRateLimiter } from './rate-limits/domain-rate-limiter.js';
import { RedisRateLimitStore } from './middleware/redis-rate-limit-store.js';
import {
  escapeHtml,
  renderScorePage,
  renderDomainPage,
  renderForSalePage,
  renderComparePage,
  renderErrorPage,
  dataSourcesPageHtml,
} from './views/index.js';
import type { DomainSiteRepository } from '../db/repositories/domain-site-repository.js';
import type { LegalContent } from '../services/legal-content.js';
import type { WaitlistService } from '../services/waitlist-service.js';
import { dpaIsGeneratable, renderDpaHtml } from '../services/dpa-content.js';

const logger = getLogger();

/**
 * Linear-time email shape check. A single `/^[^@]+@[^@]+\.[^@]+$/` regex has
 * overlapping quantifiers and backtracks polynomially on hostile input.
 * Splitting on the one '@' and checking the domain's last dot is O(n).
 */
function isValidEmailAddress(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (/[\s@]/.test(local)) return false;
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || dot >= domain.length - 1) return false;
  return !/[\s@]/.test(domain);
}

/** The sub-processors published in the privacy notice and in the DPA. */
const DPA_SUBPROCESSORS = [
  {
    name: 'Hetzner Online GmbH',
    purpose: 'application and database hosting',
    country: 'Germany',
    mechanism: 'no transfer outside the EEA',
  },
  {
    name: 'Stripe Payments Europe Ltd.',
    purpose: 'subscription billing and tax calculation',
    country: 'Ireland / United States',
    mechanism: 'no transfer for the payment account; SCCs for US support access',
  },
  {
    name: 'Backblaze Inc.',
    purpose: 'off-host backup storage when enabled',
    country: 'United States',
    mechanism: 'EU-US Data Privacy Framework where certified, otherwise SCCs',
  },
  {
    name: 'Okta, Inc. (Auth0)',
    purpose: 'single sign-on when used',
    country: 'United States',
    mechanism: 'EU-US Data Privacy Framework where certified, otherwise SCCs',
  },
] as const;

/** Repository root, for the license and third-party notices shipped with the service. */
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function shippedTextFile(name: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, name), 'utf-8');
  } catch {
    return null;
  }
}

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
  /**
   * Published for-sale pages (ADR-0083, M2). When provided, the router
   * serves `/for-sale/:domain` and includes those pages in the sitemap.
   */
  domainSiteRepo?: DomainSiteRepository | undefined;
  /**
   * IndexNow verification key. When set, the router serves the key file
   * at the site root (`/<key>.txt`) so search engines can verify ownership.
   */
  indexNowKey?: string | undefined;
  /**
   * First-party waitlist with stored consent proof and double opt-in.
   * When absent, the landing page falls back to `CLOUD_WAITLIST_URL`.
   */
  waitlistService?: WaitlistService | undefined;
  /**
   * The legal surface (legal notice, terms of service, privacy notice).
   * Served unauthenticated at `/public/legal` because the documents must be
   * reachable by anyone, including the crawlers that index the public
   * namespace.
   */
  legalContent?: LegalContent | undefined;
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
 * Serve the IndexNow ownership-verification file at the site root
 * (`/<key>.txt`, ADR-0083 M2). Mount at the root level, not under /public:
 * search engines fetch the key from the host root. Returns 404 for any
 * other filename and when no key is configured.
 */
export function createIndexNowKeyHandler(options: PublicRouterOptions = {}): RequestHandler {
  const key = options.indexNowKey;
  return (req: Request, res: Response): void => {
    const requested = (req.params['key'] as string | undefined) ?? '';
    if (key === undefined || key.length < 8 || requested !== key) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain');
    res.send(key);
  };
}

/**
 * Serve `/.well-known/security.txt` (RFC 9116).
 *
 * The file is generated rather than committed because the contact and the
 * canonical URL are deployment data: a self-hosted fork must publish its own
 * contact, not the upstream one. An expired file is worse than no file, so
 * the Expires field is one year after the response is generated.
 *
 * When no security contact is configured the handler returns 404: an empty
 * Contact field is not a security policy.
 */
export function createSecurityTxtHandler(
  options: PublicRouterOptions & {
    securityContact?: string | undefined;
    securityPolicyUrl?: string | undefined;
  } = {},
): RequestHandler {
  return (req: Request, res: Response): void => {
    const contact = options.securityContact?.trim();
    if (!contact) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const siteUrl = siteUrlFor(req, options);
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      `Contact: mailto:${contact}`,
      `Expires: ${expires}`,
      'Preferred-Languages: en',
      `Canonical: ${siteUrl}/.well-known/security.txt`,
      ...(options.securityPolicyUrl ? [`Policy: ${options.securityPolicyUrl}`] : []),
    ];
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('text/plain');
    res.send(`${lines.join('\n')}\n`);
  };
}

/** Never let a malformed stored snapshot turn a public read into a 500. */
function parseScoreSafely(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
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

  // One store per limiter. express-rate-limit keys a counter by client IP
  // alone, so a shared store would let a GET consume the POST quota (and
  // a POST consume the GET quota); the library also refuses the reuse.
  const publicStore: Store | undefined =
    redisClient?.isConnected === true
      ? new RedisRateLimitStore(redisClient, publicWindowMs, 'rl:public')
      : undefined;
  const postStore: Store | undefined =
    redisClient?.isConnected === true
      ? new RedisRateLimitStore(redisClient, postWindowMs, 'rl:post')
      : undefined;

  const publicRateLimiter = rateLimit({
    windowMs: publicWindowMs,
    max: publicMax,
    standardHeaders: true,
    legacyHeaders: false,
    ...(publicStore === undefined ? {} : { store: publicStore }),
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
  });

  const postRateLimiter = rateLimit({
    windowMs: postWindowMs,
    max: postMax,
    standardHeaders: true,
    legacyHeaders: false,
    ...(postStore === undefined ? {} : { store: postStore }),
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

  // The site-wide social preview, generated from a fixed SVG (no fabricated
  // domain or score in it).
  /**
   * DNS TXT proof of control for a published for-sale page.
   *
   * Anyone can request a token; only the person who can publish the record
   * `_dominus.<domain>` can complete the verification. The token is stored
   * hashed and removed on success.
   */
  router.post(
    '/for-sale/:domain/ownership/start',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const repo = options.domainSiteRepo;
        const domain = String(req.params.domain ?? '').toLowerCase();
        if (!repo || !isValidDomain(domain)) {
          res
            .status(404)
            .json({ error: { code: 'NOT_FOUND', message: 'No for-sale page for this domain' } });
          return;
        }
        const site = await repo.findByDomainPublic(domain);
        if (!site) {
          res
            .status(404)
            .json({ error: { code: 'NOT_FOUND', message: 'No for-sale page for this domain' } });
          return;
        }
        const token = randomBytes(24).toString('hex');
        await repo.setOwnershipToken(domain, createHash('sha256').update(token).digest('hex'));
        res.json({
          record: `_dominus.${domain}`,
          type: 'TXT',
          value: `dominus-verify=${token}`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/for-sale/:domain/ownership/verify',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const repo = options.domainSiteRepo;
        const domain = String(req.params.domain ?? '').toLowerCase();
        if (!repo || !isValidDomain(domain)) {
          res
            .status(404)
            .json({ error: { code: 'NOT_FOUND', message: 'No for-sale page for this domain' } });
          return;
        }
        const expected = await repo.ownershipTokenHash(domain);
        if (!expected) {
          res.status(409).json({
            error: { code: 'NO_PENDING_VERIFICATION', message: 'Request a token before verifying' },
          });
          return;
        }
        let records: string[][] = [];
        try {
          records = await resolveTxt(`_dominus.${domain}`);
        } catch {
          res.status(422).json({
            error: {
              code: 'TXT_RECORD_NOT_FOUND',
              message:
                'The DNS TXT record is not visible yet. DNS propagation can take a few minutes.',
            },
          });
          return;
        }
        const presented = records.flat().join('');
        const match = /dominus-verify=([0-9a-f]{48})/.exec(presented);
        if (!match || createHash('sha256').update(match[1]!).digest('hex') !== expected) {
          res.status(422).json({
            error: {
              code: 'TXT_RECORD_MISMATCH',
              message: 'The DNS TXT value does not match the token issued for this page',
            },
          });
          return;
        }
        await repo.confirmOwnership(domain, expected);
        res.json({ verified: true, domain });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post('/waitlist', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = options.waitlistService;
      if (!service || !service.canAccept) {
        res.status(503).json({
          error: {
            code: 'WAITLIST_UNAVAILABLE',
            message: 'The waitlist is not accepting addresses on this deployment',
          },
        });
        return;
      }
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      // The version comes from the published documents, never from the form:
      // a client cannot claim to have accepted a text we did not publish.
      const consentVersion = options.legalContent?.version ?? '';
      if (!isValidEmailAddress(email) || !consentVersion) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'A valid email address and a consent version are required',
          },
        });
        return;
      }
      await service.subscribe(email, consentVersion);
      res.status(202).json({ message: 'Check your inbox to confirm your registration' });
    } catch (err) {
      next(err);
    }
  });

  router.get('/waitlist/confirm', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const service = options.waitlistService;
      if (!service || token.length < 16) {
        res
          .status(400)
          .type('html')
          .send(
            '<!doctype html><title>Invalid link</title><p>This confirmation link is not valid.</p>',
          );
        return;
      }
      const confirmed = await service.confirm(token);
      res
        .type('html')
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Waitlist confirmation</title></head>` +
            `<body><h1>${confirmed ? 'Registration confirmed' : 'Already confirmed or unknown link'}</h1>` +
            `<p>${
              confirmed
                ? 'Thank you. We will contact this address when DOMINUS Cloud opens.'
                : 'This link was already used or does not match a registration.'
            }</p><p><a href="/">Back to DOMINUS</a></p></body></html>`,
        );
    } catch (err) {
      next(err);
    }
  });

  router.get('/waitlist/withdraw', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const service = options.waitlistService;
      if (!service || token.length < 16) {
        res
          .status(400)
          .type('html')
          .send(
            '<!doctype html><title>Invalid link</title><p>This withdrawal link is not valid.</p>',
          );
        return;
      }
      const removed = await service.withdraw(token);
      res
        .type('html')
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Waitlist withdrawal</title></head>` +
            `<body><h1>${removed ? 'Registration withdrawn' : 'No registration found'}</h1>` +
            `<p>The address and its consent record have been removed.</p>` +
            `<p><a href="/">Back to DOMINUS</a></p></body></html>`,
        );
    } catch (err) {
      next(err);
    }
  });

  router.get('/og-image.png', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const png = await generateBrandOgPng();
      res.set('Cache-Control', 'public, max-age=86400');
      res.type('png').send(png);
    } catch (err) {
      next(err);
    }
  });

  // The legal surface. Public and cacheable: the legal notice, the terms of
  // service and the privacy notice must be readable without an account, by
  // anyone, including the crawlers that index the public namespace.
  router.get('/legal', (_req: Request, res: Response) => {
    if (!options.legalContent) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Legal documents are not available' },
      });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json(options.legalContent);
  });

  // The factual pages the legal notice points at. They are server-rendered,
  // not SPA routes, so a crawler and a user with JavaScript disabled see the
  // same attribution. The file is read from disk rather than copied into the
  // view: there must be exactly one copy of the third-party notices.
  router.get('/data-sources', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(dataSourcesPageHtml(options.legalContent?.sourceCodeUrl));
  });
  router.get('/third-party-notices', (_req: Request, res: Response) => {
    const notices = shippedTextFile('THIRD-PARTY-NOTICES.md');
    if (notices === null) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Third-party notices are not available' },
      });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.type('text/markdown').send(notices);
  });
  router.get('/license', (_req: Request, res: Response) => {
    const license = shippedTextFile('LICENSE');
    if (license === null) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'The license text is not available' },
      });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.type('text/plain').send(license);
  });
  router.get('/dpa', (_req: Request, res: Response) => {
    // A template with `[●]` fields is not a contract. Serve the agreement
    // generated from the deployment's operator identity, or nothing at all.
    const legal = options.legalContent;
    if (!legal || !dpaIsGeneratable(legal.identity)) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'The data processing agreement is not available' },
      });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(
      renderDpaHtml({
        identity: legal.identity,
        sourceCodeUrl: legal.sourceCodeUrl,
        subProcessors: DPA_SUBPROCESSORS,
      }),
    );
  });

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
    '/for-sale/:domain',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const domain = req.params.domain as string | undefined;
        if (!domain || !isValidDomain(domain)) {
          res.status(400).json({
            error: { code: 'INVALID_DOMAIN', message: `'${domain ?? ''}' is not a valid domain` },
          });
          return;
        }
        if (!options.domainSiteRepo) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'No for-sale pages are published' },
          });
          return;
        }

        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        if (!(await domainRateLimiter.check(ip, domain))) {
          res.status(429).json({
            error: { code: 'RATE_LIMITED', message: 'Too many requests for this domain' },
          });
          return;
        }

        const site = await options.domainSiteRepo.findByDomainPublic(domain);
        if (site === null) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: `${domain} has no published for-sale page` },
          });
          return;
        }

        res.set('Cache-Control', 'public, max-age=3600');
        if (req.accepts('html')) {
          res.send(renderForSalePage(site, siteUrlForReq(req)));
        } else {
          res.json({
            domain: site.domain,
            headline: site.headline,
            summary: site.summary,
            askingPriceEur: site.askingPriceEur,
            score: parseScoreSafely(site.scoreJson),
            contact: site.contact,
            publishedAt: site.publishedAt,
          });
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

        // Published for-sale pages (ADR-0083, M2) — buyer discoverability.
        const forSaleUrls = options.domainSiteRepo
          ? (await options.domainSiteRepo.listForSitemap())
              .map((site) => {
                const lastmod = site.publishedAt
                  ? new Date(site.publishedAt).toISOString().split('T')[0]
                  : new Date().toISOString().split('T')[0];
                return `
  <url>
    <loc>${escapeHtml(origin)}/public/for-sale/${escapeHtml(site.domain)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
              })
              .join('')
          : '';

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls}${forSaleUrls}
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
