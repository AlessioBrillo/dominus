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
import { parseCookies } from '../../utils/cookies.js';
import { getLogger } from '../../logger.js';
import { isTrustedRequestOrigin } from '../middleware/csrf.js';
import { resolveRole } from '../middleware/auth.js';
import {
  InvitationEmailMismatchError,
  InvitationInvalidError,
  TeamSeatLimitError,
} from '../../services/team-service.js';

const logger = getLogger();

const OIDC_COOKIE = 'dominus_oidc';
const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000;

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
  /** Origins allowed to POST the session cookie (CSRF guard on /logout). */
  trustedOrigins: ReadonlySet<string>;
  mintSession(
    sub: string,
    tenantId: string | undefined,
    role: string | undefined,
    email?: string,
  ): Promise<string>;
  /** Platform-operator allowlist; the SPA must see the role the API will enforce. */
  operatorSubjects?: ReadonlySet<string> | undefined;
  /**
   * Redeem a team invitation for the signed-in user. Resolves to the tenant
   * and session role they now belong to. Omitted = invitations are disabled.
   */
  acceptInvitation?(
    token: string,
    userId: string,
    verifiedEmail?: string,
  ): Promise<{ tenantId: string; role: string }>;
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

      const session = await deps.mintSession(
        validated.userId,
        validated.tenantId,
        validated.role,
        validated.email,
      );

      res.clearCookie(OIDC_COOKIE, { path: '/' });
      res.cookie(SESSION_COOKIE, session, cookieOptions(deps.sessionTtlMs));
      res.redirect(appBase);
    } catch (err) {
      logger.warn({ err }, 'SSO callback failed');
      return fail();
    }
  });

  // Clears the local session and hands the SPA the IdP logout URL so it can
  // end the single-sign-on session too; otherwise the next "Sign in with SSO"
  // would silently log the same user straight back in.
  router.post('/logout', (req: Request, res: Response) => {
    if (!isTrustedRequestOrigin(req, deps.trustedOrigins)) {
      res
        .status(403)
        .json({ error: { code: 'CSRF_REJECTED', message: 'Untrusted request origin' } });
      return;
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ logoutUrl: deps.provider.logoutUrl(appBase) });
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
      role: resolveRole(claims.role, { userId: claims.sub }, deps.operatorSubjects) ?? null,
    });
  });

  // Join a team from an invitation link. The caller must already hold a
  // session (signed in via SSO); on success the session is re-issued for the
  // team's tenant, because tenant and role live inside the session JWT.
  router.post('/accept-invitation', async (req: Request, res: Response) => {
    if (!deps.acceptInvitation) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitations are disabled' } });
      return;
    }
    if (!isTrustedRequestOrigin(req, deps.trustedOrigins)) {
      res
        .status(403)
        .json({ error: { code: 'CSRF_REJECTED', message: 'Untrusted request origin' } });
      return;
    }
    const session = parseCookies(req)[SESSION_COOKIE];
    const claims = session ? await deps.sessionVerifier.verify(session) : null;
    if (!claims) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in first' } });
      return;
    }
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'token is required' } });
      return;
    }
    try {
      const joined = await deps.acceptInvitation(token, claims.sub, claims.email);
      const renewed = await deps.mintSession(
        claims.sub,
        joined.tenantId,
        joined.role,
        claims.email,
      );
      res.cookie(SESSION_COOKIE, renewed, cookieOptions(deps.sessionTtlMs));
      res.json({ tenantId: joined.tenantId, role: joined.role });
    } catch (err) {
      if (err instanceof InvitationInvalidError) {
        res.status(400).json({ error: { code: 'INVITATION_INVALID', message: err.message } });
        return;
      }
      if (err instanceof InvitationEmailMismatchError) {
        res
          .status(403)
          .json({ error: { code: 'INVITATION_EMAIL_MISMATCH', message: err.message } });
        return;
      }
      if (err instanceof TeamSeatLimitError) {
        res.status(409).json({ error: { code: 'SEAT_LIMIT_EXCEEDED', message: err.message } });
        return;
      }
      logger.warn({ err }, 'Accepting invitation failed');
      res
        .status(500)
        .json({ error: { code: 'INTERNAL_ERROR', message: 'Could not accept invitation' } });
    }
  });

  return router;
}
