import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import { runWithTenant } from '../../utils/tenant-context.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

interface AuthRateEntry {
  failures: number;
  resetAt: number;
}

const AUTH_RATE_MAP = new Map<string, AuthRateEntry>();
const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 60_000;

function cleanupAuthRateMap(): void {
  const now = Date.now();
  for (const [key, entry] of AUTH_RATE_MAP) {
    if (now >= entry.resetAt) AUTH_RATE_MAP.delete(key);
  }
}

function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = AUTH_RATE_MAP.get(ip);
  if (entry === undefined || now >= entry.resetAt) {
    entry = { failures: 1, resetAt: now + AUTH_WINDOW_MS };
    AUTH_RATE_MAP.set(ip, entry);
    return true;
  }
  entry.failures++;
  if (entry.failures > MAX_AUTH_FAILURES) {
    return false;
  }
  return true;
}

// Periodic cleanup every 5 minutes to prevent unbounded map growth
setInterval(cleanupAuthRateMap, 5 * 60_000).unref();

export function createAuthMiddleware(provider: AuthProvider) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!provider.isActive) {
      req.tenantId = 'default';
      runWithTenant('default', () => next());
      return;
    }

    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') {
      if (!checkAuthRateLimit(clientIp)) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many authentication attempts. Try again later.',
          },
        });
        return;
      }
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing Authorization header. Use: Authorization: Bearer <api-key>',
        },
      });
      return;
    }

    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match || !match[1]) {
      if (!checkAuthRateLimit(clientIp)) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many authentication attempts. Try again later.',
          },
        });
        return;
      }
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid Authorization format. Use: Authorization: Bearer <api-key>',
        },
      });
      return;
    }

    const apiKey = match[1];
    const result = await provider.validate(apiKey);

    if (!result.authenticated) {
      if (!checkAuthRateLimit(clientIp)) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many authentication attempts. Try again later.',
          },
        });
        return;
      }
      logger.warn({ ip: clientIp }, 'Authentication failed');
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Invalid API key' },
      });
      return;
    }

    // Reset failure count on successful auth
    AUTH_RATE_MAP.delete(clientIp);

    req.tenantId = result.tenantId ?? 'default';
    runWithTenant(req.tenantId, () => next());
  };
}
