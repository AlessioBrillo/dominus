import type { Request, Response, NextFunction } from 'express';

/**
 * Content-Security-Policy directives for production.
 *
 * Design rationale:
 * - script-src 'self' only — ALL scripts are Vite-bundled assets served
 *   from same origin. No inline scripts in the SPA. Server-rendered
 *   public pages use JSON-LD in script tags with type="application/ld+json"
 *   which is not executable JS and does not require 'unsafe-inline'.
 * - style-src 'self' 'unsafe-inline' — KEPT for the server-rendered
 *   public score pages (public-router.ts) which embed <style> blocks
 *   for isolated HTML rendering. The SPA (Vite + Tailwind) bundles all
 *   CSS and would work with style-src 'self' alone.
 * - TODO(v0.7.0): Remove style-src 'unsafe-inline' by extracting public
 *   page CSS to external files served from /public/static/assets/.
 *
 * See: docs/adr/0031-production-hardening.md
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
];

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  const isApiRequest = req.path.startsWith('/api/');
  if (!isApiRequest) {
    res.setHeader('Content-Security-Policy', CSP_DIRECTIVES.join('; '));
  }

  const proto = req.headers['x-forwarded-proto'] as string | undefined;
  const isHttps = req.protocol === 'https' || proto === 'https';
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );

  next();
}
