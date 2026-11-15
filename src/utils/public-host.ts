// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';

/**
 * Whether a host name can be a public HTTP endpoint.
 *
 * The webhook URL of a tenant is chosen by the tenant and fetched by the
 * SERVER: without a check, a customer can make the platform POST to
 * 127.0.0.1, to the cloud metadata service (169.254.169.254) or to any
 * private address (SSRF). The tenant never reads the response, but the
 * request itself is the capability: it reaches services that only trust
 * the network.
 *
 * The check rejects the literal forms:
 *
 * - loopback (127.0.0.0/8, ::1), the unspecified address (0.0.0.0, ::);
 * - private ranges (10/8, 172.16/12, 192.168/16, fc00::/7);
 * - link-local (169.254/16, fe80::/10) and carrier-grade NAT (100.64/10);
 * - single-label host names (`http://intranet/`), which are internal by
 *   definition;
 * - `localhost` in every form.
 *
 * A public host name that RESOLVES to a private address (DNS rebinding, a
 * hostile record) is not caught here: the resolver is consulted after the
 * check. That residual risk is documented in ADR-0107 and is bounded by the
 * egress policy of the deployment, not by this function.
 */
export function isPubliclyRoutableHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return false;

  const family = isIP(host);
  if (family === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }

  if (family === 6) {
    if (host === '::' || host === '::1') return false;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return false;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped?.[1]) return isPubliclyRoutableHost(mapped[1]);
    return true;
  }

  // A name without a dot has no public suffix: it is an internal name.
  return host.includes('.');
}
