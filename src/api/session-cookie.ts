// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Options shared by the SSO (ADR-0062) and magic-link session cookies.
 * Both flows mint the same httpOnly JWT; keeping the cookie contract in one
 * place prevents one of them from silently becoming readable by JavaScript
 * or from being sent over an insecure connection.
 */
export function sessionCookieOptions(maxAgeMs: number): Record<string, unknown> {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: maxAgeMs,
  };
}
