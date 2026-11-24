// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SESSION_COOKIE, type SessionJwtVerifier } from '../../providers/auth/session-jwt.js';
import { parseCookies } from '../../utils/cookies.js';
import { sessionCookieOptions } from '../session-cookie.js';
import type { MagicLinkService } from '../../services/magic-link-service.js';

const emailSchema = z.string().trim().email().max(254);
const tokenSchema = z.string().min(16).max(256);

export interface MagicLinkRouterDeps {
  service: MagicLinkService;
  sessionTtlMs: number;
  sessionVerifier: SessionJwtVerifier;
}

/**
 * Passwordless browser sign-in. Mounted only when the service is enabled:
 * an unconfigured deployment answers 404 rather than a form that can never
 * deliver a link.
 */
export function createMagicLinkRouter(deps: MagicLinkRouterDeps): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ enabled: deps.service.enabled });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ signedOut: true });
  });

  /** Restore the browser session on reload, without an API key. */
  router.get('/me', async (req: Request, res: Response) => {
    const cookie = parseCookies(req)[SESSION_COOKIE];
    const claims = cookie === undefined ? undefined : await deps.sessionVerifier.verify(cookie);
    if (claims == null) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'No browser session' } });
      return;
    }
    res.json({
      authenticated: true,
      sub: claims.sub,
      tenantId: claims.tenantId ?? null,
      email: claims.email ?? null,
    });
  });

  // Always 202, even for an address with no seat: an endpoint that answers
  // differently for existing accounts is an account-enumeration oracle.
  router.post('/request', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = emailSchema.safeParse(req.body?.email);
      if (parsed.success) {
        try {
          await deps.service.request(parsed.data);
        } catch {
          // Delivery failure is logged by the mailer; never disclosed here.
        }
      }
      res.status(202).json({ sent: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/consume', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = tokenSchema.safeParse(req.body?.token);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: 'MAGIC_LINK_INVALID', message: 'Invalid sign-in link' },
        });
        return;
      }
      const confirmation = await deps.service.confirm(parsed.data);
      if (confirmation === undefined) {
        res.status(400).json({
          error: { code: 'MAGIC_LINK_INVALID', message: 'Invalid or expired sign-in link' },
        });
        return;
      }
      res.cookie(SESSION_COOKIE, confirmation.token, sessionCookieOptions(deps.sessionTtlMs));
      // No API key is returned: the browser holds an httpOnly session, while
      // the CLI keeps using keys issued in Settings.
      res.json({
        authenticated: true,
        tenantId: confirmation.tenantId,
        email: confirmation.email,
        role: confirmation.role,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
