import type { Request, Response, NextFunction } from 'express';

/**
 * Cache-Control middleware for GET endpoints.
 *
 * Sets Cache-Control: private, max-age=<seconds> on GET responses.
 * The `private` directive prevents shared caches (CDN, proxy) from
 * caching auth-dependent data, while allowing the browser and
 * intermediary TLS-terminating proxies to reuse the response within
 * the TTL.
 */
export function responseCache(ttlSeconds: number = 60) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (_req.method !== 'GET') {
      next();
      return;
    }
    res.set('Cache-Control', `private, max-age=${ttlSeconds}`);
    next();
  };
}
