import type { Request, Response, NextFunction } from 'express';
import type pino from 'pino';

/** Parameters whose values are redacted from request logs. */
const REDACTED_QUERY_PARAMS = new Set(['key', 'api_key', 'apiKey', 'token', 'secret']);

/**
 * Safely sanitise a URL for logging: strip query params that may carry
 * credentials (API keys, tokens) and truncate long paths.
 */
function sanitiseUrl(raw: string): string {
  const idx = raw.indexOf('?');
  if (idx === -1) return raw;
  const path = raw.slice(0, idx);
  const qs = raw.slice(idx + 1);
  if (!qs) return path;
  const sanitised = qs
    .split('&')
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const k = pair.slice(0, eqIdx);
        if (REDACTED_QUERY_PARAMS.has(k)) {
          return `${k}=[REDACTED]`;
        }
      }
      return pair;
    })
    .join('&');
  return `${path}?${sanitised}`;
}

export function createRequestLogger(
  logger: pino.Logger,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          method: req.method,
          url: sanitiseUrl(req.url),
          status: res.statusCode,
          durationMs: Date.now() - start,
        },
        'http request',
      );
    });
    next();
  };
}
