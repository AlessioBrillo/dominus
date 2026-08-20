// SPDX-License-Identifier: AGPL-3.0-only
import type { Request } from 'express';

/**
 * Minimal Cookie header parser shared by the SSO routes and the auth
 * middleware. Malformed percent-encoding is skipped instead of throwing —
 * an unhandled decodeURIComponent URIError would turn a hostile `Cookie`
 * header into a 500 on otherwise unauthenticated endpoints.
 */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding — drop the cookie, keep the request.
    }
  }
  return out;
}
