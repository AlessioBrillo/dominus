import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import { runWithTenant } from '../../utils/tenant-context.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 60_000;

async function checkAuthRateLimit(db: DatabaseProvider, ip: string): Promise<boolean> {
  const now = Date.now();
  const resetAt = new Date(now + AUTH_WINDOW_MS).toISOString();

  const row = await db.queryOne<{ failures: number; reset_at: string }>(
    'SELECT failures, reset_at FROM auth_rate_limits WHERE ip = ?',
    [ip],
  );

  if (!row || now >= new Date(row.reset_at).getTime()) {
    await db.exec(
      `INSERT INTO auth_rate_limits (ip, failures, reset_at)
       VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET failures = 1, reset_at = ?, updated_at = CURRENT_TIMESTAMP`,
      [ip, resetAt, resetAt],
    );
    return true;
  }

  const newFailures = row.failures + 1;
  await db.exec(
    `UPDATE auth_rate_limits SET failures = ?, updated_at = CURRENT_TIMESTAMP WHERE ip = ?`,
    [newFailures, ip],
  );

  return newFailures <= MAX_AUTH_FAILURES;
}

async function resetAuthRateLimit(db: DatabaseProvider, ip: string): Promise<void> {
  await db.exec('DELETE FROM auth_rate_limits WHERE ip = ?', [ip]);
}

export function createAuthMiddleware(provider: AuthProvider, db: DatabaseProvider) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (!provider.isActive) {
      // Apply IP-based rate limiting even when auth is disabled
      const allowed = await checkAuthRateLimit(db, clientIp).catch(() => true);
      if (!allowed) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Try again later.',
          },
        });
        return;
      }
      req.tenantId = 'default';
      runWithTenant('default', () => next());
      return;
    }

    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') {
      const allowed = await checkAuthRateLimit(db, clientIp);
      if (!allowed) {
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
      const allowed = await checkAuthRateLimit(db, clientIp);
      if (!allowed) {
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
      const allowed = await checkAuthRateLimit(db, clientIp);
      if (!allowed) {
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
    await resetAuthRateLimit(db, clientIp);

    req.tenantId = result.tenantId ?? 'default';
    runWithTenant(req.tenantId, () => next());
  };
}
