// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/**
 * Session cookies for the SSO flow (ADR-0062). Keys are HKDF-derived from
 * AUTH0_CLIENT_SECRET so no new secret needs to be managed: rotating the
 * Auth0 client secret immediately invalidates every session and PKCE cookie.
 * The salt/info labels are static — the derivation is deterministic.
 */

export interface SessionClaims {
  sub: string;
  tenantId?: string | undefined;
  role?: string | undefined;
}

export const SESSION_COOKIE = 'dominus_session';

export interface SessionJwtVerifier {
  verify(token: string): Promise<SessionClaims | null>;
}

export function deriveSessionKey(clientSecret: string, info: string): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      'sha256',
      Buffer.from(clientSecret, 'utf8'),
      createHash('sha256').update('dominus-session-v1').digest(),
      Buffer.from(info, 'utf8'),
      32,
    ),
  );
}

export function createSessionJwtMinter(
  clientSecret: string,
  ttlHours: number,
): { mint: (claims: SessionClaims) => Promise<string>; verify: SessionJwtVerifier['verify'] } {
  const key = deriveSessionKey(clientSecret, 'session-jwt');

  const mint = (claims: SessionClaims): Promise<string> =>
    new SignJWT({ tenant_id: claims.tenantId, role: claims.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${ttlHours}h`)
      .sign(key);

  const verify: SessionJwtVerifier['verify'] = async (token) => {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
      const claims: SessionClaims = { sub: payload.sub };
      if (typeof payload.tenant_id === 'string') claims.tenantId = payload.tenant_id;
      if (typeof payload.role === 'string') claims.role = payload.role;
      return claims;
    } catch {
      return null;
    }
  };

  return { mint, verify };
}

export function signTransientCookie(clientSecret: string, value: string): string {
  const key = deriveSessionKey(clientSecret, 'pkce-cookie');
  const mac = createHmac('sha256', key).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function verifyTransientCookie(clientSecret: string, token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const key = deriveSessionKey(clientSecret, 'pkce-cookie');
  const expected = createHmac('sha256', key).update(value).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length) return null;
  return timingSafeEqual(actual, expected) ? value : null;
}
