// SPDX-License-Identifier: AGPL-3.0-only
import type { Request, Response, NextFunction } from 'express';
import type { AuthProvider } from '../../providers/auth/auth-provider.js';
import type { SessionJwtVerifier } from '../../providers/auth/session-jwt.js';
import { SESSION_COOKIE } from '../../providers/auth/session-jwt.js';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import { runWithTenant } from '../../utils/tenant-context.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 60_000;

async function checkAuthRateLimit(db: DatabaseProvider, ip: string): Promise<boolean> {
  try {
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
  } catch (error) {
    logger.error({ ip, error }, 'Auth rate limit check failed — denying request');
    return false;
  }
}

async function resetAuthRateLimit(db: DatabaseProvider, ip: string): Promise<void> {
  await db.exec('DELETE FROM auth_rate_limits WHERE ip = ?', [ip]);
}

export interface AuthMiddlewareOptions {
  /** When true, an authenticated request with no resolvable tenantId is
   *  rejected (403) instead of silently defaulting to 'default'. Enable for
   *  any multi-tenant AUTH_PROVIDER (db/auth0) — see ADR-0032/ADR-0034. */
  requireTenant?: boolean;
  /** When set, the httpOnly SSO session cookie (ADR-0062) is accepted as an
   *  alternative to a Bearer token. Browser flows authenticate via the
   *  cookie; API/CLI clients keep using Authorization headers. */
  sessionVerifier?: SessionJwtVerifier;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Extract the API key from the request, checking:
 * 1. Authorization header (Bearer token) — standard API calls
 * 2. `token` query parameter — SSE/EventSource (cannot set custom headers)
 *
 * SSE auth via query param is acceptable because:
 * - The endpoint is GET-only, read-only (stage progress events)
 * - The token is transmitted over HTTPS (never HTTP)
 * - The token is never logged or leaked in responses
 * - This is a standard pattern (AWS, Stripe, etc. use URL-based SSE auth)
 */
function extractApiKey(req: Request): string | null {
  const header = req.headers['authorization'];
  if (header && typeof header === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (match && match[1]) return match[1];
  }

  const tokenParam = req.query['token'];
  if (typeof tokenParam === 'string' && tokenParam.length > 0) {
    return tokenParam;
  }

  return null;
}

export function createAuthMiddleware(
  provider: AuthProvider,
  db: DatabaseProvider,
  options: AuthMiddlewareOptions = {},
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    if (!provider.isActive) {
      const allowed = await checkAuthRateLimit(db, clientIp);
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

    const apiKey = extractApiKey(req);
    if (!apiKey) {
      // Browser session cookie fallback (ADR-0062): validated against the
      // same HMAC-keyed session store used by the OIDC login flow.
      if (options.sessionVerifier) {
        const session = parseCookies(req)[SESSION_COOKIE];
        if (session) {
          const claims = await options.sessionVerifier.verify(session);
          if (claims) {
            if (options.requireTenant && !claims.tenantId) {
              logger.warn(
                { ip: clientIp },
                'Session authenticated but missing tenantId — rejecting',
              );
              res.status(403).json({
                error: { code: 'FORBIDDEN', message: 'Session is not scoped to a tenant' },
              });
              return;
            }
            req.tenantId = claims.tenantId ?? 'default';
            req.auth = {
              userId: claims.sub,
              tenantId: claims.tenantId,
              role: claims.role,
            };
            runWithTenant(req.tenantId, () => next());
            return;
          }
        }
      }
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
          message: 'Missing Authorization header or token query parameter.',
        },
      });
      return;
    }

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
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
      });
      return;
    }

    if (options.requireTenant && !result.tenantId) {
      logger.warn({ ip: clientIp }, 'Authenticated request missing tenantId — rejecting');
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Token is not scoped to a tenant' },
      });
      return;
    }

    // Reset failure count on successful auth
    await resetAuthRateLimit(db, clientIp);

    req.tenantId = result.tenantId ?? 'default';
    req.auth = {
      userId: result.userId,
      tenantId: result.tenantId,
      role: result.role,
      keyName: result.keyName,
    };
    runWithTenant(req.tenantId, () => next());
  };
}
