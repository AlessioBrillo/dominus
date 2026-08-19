// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, createHash } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { OidcProvider } from '../../providers/auth/oidc-provider.js';
import {
  SESSION_COOKIE,
  signTransientCookie,
  verifyTransientCookie,
  type SessionJwtVerifier,
} from '../../providers/auth/session-jwt.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const OIDC_COOKIE = 'dominus_oidc';
const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000;

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

function cookieOptions(maxAgeMs: number): Record<string, unknown> {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export interface OidcRouterDeps {
  provider: OidcProvider;
  /** HMAC secret (HKDF-derived key material is derived internally). */
  clientSecret: string;
  callbackUrl: string;
  /** Origin of the SPA — redirect target after login/logout. */
  appOrigin: string;
  sessionTtlMs: number;
  sessionVerifier: SessionJwtVerifier;
  mintSession(sub: string, tenantId: string | undefined, role: string | undefined): Promise<string>;
}

export function createOidcRouter(deps: OidcRouterDeps): Router {
  const router = Router();
  // Normalize the SPA origin so redirect targets never carry a double slash.
  const appBase = deps.appOrigin.endsWith('/') ? deps.appOrigin.slice(0, -1) : deps.appOrigin;

  router.get('/start', (_req: Request, res: Response) => {
    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const exp = Date.now() + OIDC_COOKIE_TTL_MS;

    const cookieValue = signTransientCookie(
      deps.clientSecret,
      [state, codeVerifier, exp].join('.'),
    );
    res.cookie(OIDC_COOKIE, cookieValue, cookieOptions(OIDC_COOKIE_TTL_MS));
    res.redirect(
      deps.provider.buildAuthorizeUrl({
        state,
        codeChallenge,
        redirectUri: deps.callbackUrl,
      }),
    );
  });

  router.get('/callback', async (req: Request, res: Response) => {
    const fail = (): void => {
      res.clearCookie(OIDC_COOKIE, { path: '/' });
      res.redirect(`${appBase}/?sso_error=authentication_failed`);
    };

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const rawCookie = parseCookies(req)[OIDC_COOKIE];
    const verified = rawCookie ? verifyTransientCookie(deps.clientSecret, rawCookie) : null;

    if (!code || !state || !verified) return fail();

    const parts = verified.split('.');
    const cookieState = parts[0];
    const codeVerifier = parts[1];
    const expRaw = parts[2];
    if (!cookieState || !codeVerifier || !expRaw) return fail();
    const exp = Number(expRaw);
    if (cookieState !== state || !Number.isFinite(exp) || exp < Date.now()) return fail();

    try {
      const tokens = await deps.provider.exchangeCode({
        code,
        codeVerifier,
        redirectUri: deps.callbackUrl,
      });
      const validated = await deps.provider.validateIdToken(tokens.idToken);
      if (!validated.authenticated || !validated.userId) return fail();

      const session = await deps.mintSession(validated.userId, validated.tenantId, validated.role);

      res.clearCookie(OIDC_COOKIE, { path: '/' });
      res.cookie(SESSION_COOKIE, session, cookieOptions(deps.sessionTtlMs));
      res.redirect(appBase);
    } catch (err) {
      logger.warn({ err }, 'SSO callback failed');
      return fail();
    }
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/me', async (req: Request, res: Response) => {
    const session = parseCookies(req)[SESSION_COOKIE];
    if (!session) {
      res.status(401).json({ authenticated: false });
      return;
    }
    const claims = await deps.sessionVerifier.verify(session);
    if (!claims) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      sub: claims.sub,
      tenantId: claims.tenantId ?? null,
      role: claims.role ?? null,
    });
  });

  return router;
}
