import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from '../db/provider/interface.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import { isValidDomain, parseDomain } from '../utils/domain.js';
import { getLogger } from '../logger.js';
import { generateOgPng } from './open-graph.js';

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

        const cached = cache.get(`domain:${domain.toLowerCase()}`);
        if (cached) {
          if (req.accepts('html')) {
            const d = cached as {
              domain: string;
              score: {
                expectedValue: number;
                confidence: number;
                suggestedBuyMax: number;
                suggestedListPrice: number;
                weightedScore: number;
                recommended: boolean;
                scoredAt: string;
              };
              trademark: {
                verdict: string;
                verifiedSources: string[];
                matchedMark?: string | null;
              } | null;
            };
            res.send(renderDomainPage(d.domain, d.score, d.trademark));
          } else {
            res.json(cached);
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

function renderScorePage(data: {
  slug: string;
  domain: string;
  score: {
    expectedValue: number;
    confidence: number;
    suggestedBuyMax: number;
    suggestedListPrice: number;
    weightedScore: number;
    recommended: boolean;
    scoredAt: string;
  };
  trademark: { verdict: string; verifiedSources: string[]; matchedMark?: string | null } | null;
  viewCount: number;
  createdAt: string;
}): string {
  const verdict = data.score.recommended ? 'Recommended' : 'Not Recommended';
  const tmStatus =
    data.trademark?.verdict === 'clear'
      ? 'Clear'
      : data.trademark?.verdict === 'blocked'
        ? 'Blocked'
        : 'Unverified';
  const canonicalUrl = `/public/s/${data.slug}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(data.domain)} — Domain Score | DOMINUS</title>
<meta name="description" content="${escapeHtml(data.domain)} scored: expected value €${data.score.expectedValue.toFixed(0)}, confidence ${(data.score.confidence * 100).toFixed(0)}%, weighted score ${data.score.weightedScore.toFixed(2)}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${escapeHtml(data.domain)} — Domain Score">
<meta property="og:description" content="Expected Value: €${data.score.expectedValue.toFixed(0)} | Confidence: ${(data.score.confidence * 100).toFixed(0)}% | Weighted Score: ${data.score.weightedScore.toFixed(2)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(data.domain)} — Domain Score">
<meta name="twitter:description" content="EV: €${data.score.expectedValue.toFixed(0)} | Confidence: ${(data.score.confidence * 100).toFixed(0)}%">
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: data.domain,
  description: 'Domain investment score and analysis',
  offers: {
    '@type': 'Offer',
    price: data.score.suggestedBuyMax,
    priceCurrency: 'EUR',
  },
})}
</script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e4e4e7; line-height: 1.6; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 2rem; max-width: 480px; width: 100%; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem; word-break: break-all; }
  .subtitle { color: #a1a1aa; font-size: 0.875rem; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
  .stat { background: #27272a; border-radius: 8px; padding: 0.75rem; }
  .stat-label { font-size: 0.75rem; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.25rem; font-weight: 700; margin-top: 0.25rem; }
  .stat-value.positive { color: #22c55e; }
  .stat-value.negative { color: #ef4444; }
  .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge.clear { background: #052e16; color: #22c55e; }
  .badge.blocked { background: #450a0a; color: #ef4444; }
  .badge.unverified { background: #1c1917; color: #f97316; }
  .footer { margin-top: 1.5rem; text-align: center; font-size: 0.75rem; color: #52525b; }
  .footer a { color: #818cf8; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapeHtml(data.domain)}</h1>
  <p class="subtitle">Domain Investment Score</p>
  <div class="grid">
    <div class="stat">
      <div class="stat-label">Expected Value</div>
      <div class="stat-value ${data.score.expectedValue >= 100 ? 'positive' : ''}">€${data.score.expectedValue.toFixed(0)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Confidence</div>
      <div class="stat-value">${(data.score.confidence * 100).toFixed(0)}%</div>
    </div>
    <div class="stat">
      <div class="stat-label">Weighted Score</div>
      <div class="stat-value ${data.score.weightedScore >= 50 ? 'positive' : 'negative'}">${data.score.weightedScore.toFixed(2)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Verdict</div>
      <div class="stat-value ${data.score.recommended ? 'positive' : 'negative'}">${verdict}</div>
    </div>
  </div>
  ${data.trademark ? `<div style="margin-bottom:1rem"><span class="badge ${data.trademark.verdict}">Trademark: ${tmStatus}</span></div>` : ''}
  <div class="grid">
    <div class="stat">
      <div class="stat-label">Suggested Buy Max</div>
      <div class="stat-value">€${data.score.suggestedBuyMax.toFixed(0)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Suggested List Price</div>
      <div class="stat-value">€${data.score.suggestedListPrice.toFixed(0)}</div>
    </div>
  </div>
  <p class="footer">Scored with <a href="https://dominus.app">DOMINUS</a></p>
</div>
</body>
</html>`;
}

function renderDomainPage(
  domain: string,
  score: {
    expectedValue: number;
    confidence: number;
    suggestedBuyMax: number;
    suggestedListPrice: number;
    weightedScore: number;
    recommended: boolean;
    scoredAt: string;
  },
  trademark?: {
    verdict: string;
    verifiedSources: string[];
    matchedMark?: string | null;
  } | null,
): string {
  const verdict = score.recommended ? 'Recommended' : 'Not Recommended';
  const tmStatus =
    trademark?.verdict === 'clear'
      ? 'Clear'
      : trademark?.verdict === 'blocked'
        ? 'Blocked'
        : trademark?.verdict === 'unverified'
          ? 'Unverified'
          : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(domain)} — Domain Value & Score | DOMINUS</title>
<meta name="description" content="Get the investment score for ${escapeHtml(domain)}: expected value €${score.expectedValue.toFixed(0)}, confidence ${(score.confidence * 100).toFixed(0)}%, weighted score ${score.weightedScore.toFixed(2)}. Free domain appraisal tool.">
<link rel="canonical" href="/public/domain/${escapeHtml(domain)}">
<meta property="og:title" content="${escapeHtml(domain)} — Domain Investment Score">
<meta property="og:description" content="Expected Value: €${score.expectedValue.toFixed(0)} | Confidence: ${(score.confidence * 100).toFixed(0)}% | Weighted Score: ${score.weightedScore.toFixed(2)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: domain,
  description: 'Domain investment score and appraisal',
  offers: { '@type': 'Offer', price: score.suggestedBuyMax, priceCurrency: 'EUR' },
})}
</script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e4e4e7; line-height: 1.6; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 2rem; max-width: 480px; width: 100%; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem; word-break: break-all; }
  .subtitle { color: #a1a1aa; font-size: 0.875rem; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
  .stat { background: #27272a; border-radius: 8px; padding: 0.75rem; }
  .stat-label { font-size: 0.75rem; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.25rem; font-weight: 700; margin-top: 0.25rem; }
  .stat-value.positive { color: #22c55e; }
  .stat-value.negative { color: #ef4444; }
  .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; margin-bottom: 1rem; }
  .badge.clear { background: #052e16; color: #22c55e; }
  .badge.blocked { background: #450a0a; color: #ef4444; }
  .badge.unverified { background: #1c1917; color: #f97316; }
  .footer { margin-top: 1.5rem; text-align: center; font-size: 0.75rem; color: #52525b; }
  .footer a { color: #818cf8; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapeHtml(domain)}</h1>
  <p class="subtitle">Domain Investment Score</p>
  ${tmStatus ? `<div><span class="badge ${trademark!.verdict}">Trademark: ${tmStatus}</span></div>` : ''}
  <div class="grid">
    <div class="stat"><div class="stat-label">Expected Value</div><div class="stat-value ${score.expectedValue >= 100 ? 'positive' : ''}">€${score.expectedValue.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${(score.confidence * 100).toFixed(0)}%</div></div>
    <div class="stat"><div class="stat-label">Weighted Score</div><div class="stat-value ${score.weightedScore >= 50 ? 'positive' : 'negative'}">${score.weightedScore.toFixed(2)}</div></div>
    <div class="stat"><div class="stat-label">Verdict</div><div class="stat-value ${score.recommended ? 'positive' : 'negative'}">${verdict}</div></div>
  </div>
  <div class="grid">
    <div class="stat"><div class="stat-label">Suggested Buy Max</div><div class="stat-value">€${score.suggestedBuyMax.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Suggested List Price</div><div class="stat-value">€${score.suggestedListPrice.toFixed(0)}</div></div>
  </div>
  <p class="footer">Free domain appraisal by <a href="https://dominus.app">DOMINUS</a></p>
</div>
</body>
</html>`;
}

function renderComparePage(
  domain1: string,
  score1: {
    domain: string;
    score: {
      expectedValue: number;
      confidence: number;
      suggestedBuyMax: number;
      weightedScore: number;
      recommended: boolean;
    };
    trademark: unknown | null;
  },
  domain2: string,
  score2: {
    domain: string;
    score: {
      expectedValue: number;
      confidence: number;
      suggestedBuyMax: number;
      weightedScore: number;
      recommended: boolean;
    };
    trademark: unknown | null;
  },
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compare ${escapeHtml(domain1)} vs ${escapeHtml(domain2)} — Domain Scores | DOMINUS</title>
<meta name="description" content="Side-by-side comparison of ${escapeHtml(domain1)} (EV: €${score1.score.expectedValue.toFixed(0)}) and ${escapeHtml(domain2)} (EV: €${score2.score.expectedValue.toFixed(0)}). Free domain investment comparison tool.">
<link rel="canonical" href="/public/compare/${escapeHtml(domain1)}/${escapeHtml(domain2)}">
<meta property="og:title" content="Compare ${escapeHtml(domain1)} vs ${escapeHtml(domain2)}">
<meta property="og:description" content="${escapeHtml(domain1)}: €${score1.score.expectedValue.toFixed(0)} EV — ${escapeHtml(domain2)}: €${score2.score.expectedValue.toFixed(0)} EV">
<meta property="og:type" content="website">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e4e4e7; line-height: 1.6; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1.5rem; text-align: center; }
  .row { display: flex; gap: 1rem; max-width: 800px; width: 100%; margin-bottom: 1rem; }
  .col { flex: 1; background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 1.25rem; }
  h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.25rem; word-break: break-all; }
  .stat { margin-top: 0.75rem; }
  .stat-label { font-size: 0.75rem; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.1rem; font-weight: 700; }
  .stat-value.positive { color: #22c55e; }
  .stat-value.negative { color: #ef4444; }
  .footer { margin-top: 1.5rem; text-align: center; font-size: 0.75rem; color: #52525b; }
  .footer a { color: #818cf8; text-decoration: none; }
</style>
</head>
<body>
<h1>Domain Score Comparison</h1>
<div class="row">
  <div class="col">
    <h2>${escapeHtml(domain1)}</h2>
    <div class="stat"><div class="stat-label">Expected Value</div><div class="stat-value ${score1.score.expectedValue >= 100 ? 'positive' : ''}">€${score1.score.expectedValue.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Weighted Score</div><div class="stat-value ${score1.score.weightedScore >= 50 ? 'positive' : 'negative'}">${score1.score.weightedScore.toFixed(2)}</div></div>
    <div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${(score1.score.confidence * 100).toFixed(0)}%</div></div>
    <div class="stat"><div class="stat-label">Verdict</div><div class="stat-value ${score1.score.recommended ? 'positive' : 'negative'}">${score1.score.recommended ? 'Buy' : 'Pass'}</div></div>
  </div>
  <div class="col">
    <h2>${escapeHtml(domain2)}</h2>
    <div class="stat"><div class="stat-label">Expected Value</div><div class="stat-value ${score2.score.expectedValue >= 100 ? 'positive' : ''}">€${score2.score.expectedValue.toFixed(0)}</div></div>
    <div class="stat"><div class="stat-label">Weighted Score</div><div class="stat-value ${score2.score.weightedScore >= 50 ? 'positive' : 'negative'}">${score2.score.weightedScore.toFixed(2)}</div></div>
    <div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${(score2.score.confidence * 100).toFixed(0)}%</div></div>
    <div class="stat"><div class="stat-label">Verdict</div><div class="stat-value ${score2.score.recommended ? 'positive' : 'negative'}">${score2.score.recommended ? 'Buy' : 'Pass'}</div></div>
  </div>
</div>
<p class="footer">Free domain comparison by <a href="https://dominus.app">DOMINUS</a></p>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>DOMINUS</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem;}.card{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:2rem;text-align:center;}h1{color:#ef4444;margin-bottom:0.5rem;}p{color:#a1a1aa;}</style>
</head>
<body><div class="card"><h1>${escapeHtml(message)}</h1><p>The score you are looking for does not exist.</p></div></body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
