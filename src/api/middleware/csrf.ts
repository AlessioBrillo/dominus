// SPDX-License-Identifier: AGPL-3.0-only
import type { Request } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for cookie-authenticated requests (ADR-0062 session cookie).
 *
 * `SameSite=Lax` alone leaves same-site sibling origins and older browsers
 * exposed, so state-changing requests that authenticate through the cookie
 * must also carry an `Origin` (or, failing that, `Referer`) from the trusted
 * set. Bearer-token callers never reach this check: they are not ambient
 * credentials a third-party page can make the browser attach.
 */
export function isTrustedRequestOrigin(req: Request, trusted: ReadonlySet<string>): boolean {
  if (SAFE_METHODS.has(req.method)) return true;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') return trusted.has(origin);

  const referer = req.headers.referer;
  if (typeof referer === 'string') {
    try {
      return trusted.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}
