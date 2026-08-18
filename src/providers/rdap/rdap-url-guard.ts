// SPDX-License-Identifier: AGPL-3.0-only
// Guard for RDAP redirect targets (RFC 7484 bootstrap servers may redirect
// to another registry). A hostile or compromised registry must not be able
// to steer the process toward an internal host: redirects are HTTPS-only
// and their targets must resolve exclusively to public addresses. The
// guard fails CLOSED — an unresolvable hostname is a refused redirect, not
// a bypass.
import { Resolver } from 'node:dns';

export type RedirectLookup = (hostname: string) => Promise<string[]>;

const LOOKUP_TIMEOUT_MS = 2_000;

/** True when `ip` is in a non-routable or reserved range. Fail-closed
 *  semantics: anything that is not clearly public is treated as private.
 *  Covers IPv4 (RFC 1918, loopback, link-local, CGNAT, benchmarking,
 *  multicast/reserved), IPv6 (::, ::1, fc00::/7, fe80::/10) and
 *  IPv4-mapped IPv6 (::ffff:a.b.c.d). */
export function isPrivateIpAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (mapped !== null) {
    return isPrivateIpv4(mapped[1]!);
  }
  if (parseIpv4(ip)) {
    return isPrivateIpv4(ip);
  }
  return (
    ip === '::' || ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip)
  );
}

/** Validate and reject redirect targets. `lookup` resolves the hostname to
 *  its A/AAAA addresses; it is injected so tests can stay offline, and the
 *  default production implementation is a bounded, cancellable DNS query. */
export async function assertPublicHttpsUrl(url: string, lookup: RedirectLookup): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('RDAP redirect target is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`RDAP redirect target must use HTTPS, got ${parsed.protocol}`);
  }

  const host = parsed.hostname;
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIpLiteral(bareHost)) {
    if (isPrivateIpAddress(bareHost)) {
      throw new Error(`RDAP redirect target is a private address: ${bareHost}`);
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await lookup(bareHost);
  } catch (err: unknown) {
    throw new Error(`RDAP redirect target ${bareHost} could not be resolved: ${String(err)}`, {
      cause: err,
    });
  }
  if (addresses.length === 0) {
    throw new Error(`RDAP redirect target ${bareHost} resolved to no addresses`);
  }
  const privateHits = addresses.filter((a) => isPrivateIpAddress(a));
  if (privateHits.length > 0) {
    throw new Error(
      `RDAP redirect target ${bareHost} resolves to a private address: ${privateHits.join(', ')}`,
    );
  }
}

/** Default production lookup: a per-call Resolver (never shared, so it is
 *  safe to cancel) racing a hard deadline. One family resolving is enough —
 *  a host with A but no AAAA (or vice versa) is a normal registry server. */
export function dnsLookupWithTimeout(
  hostname: string,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string[]> {
  const owned = new Resolver();
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      owned.cancel();
      reject(new Error(`DNS lookup for ${hostname} timed out`));
    }, timeoutMs).unref();
    if (signal?.aborted) {
      clearTimeout(timer);
      owned.cancel();
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      owned.cancel();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const lookup4 = new Promise<string[]>((res, rej) => {
      owned.resolve4(hostname, (err, addresses) => {
        if (err !== null) rej(err);
        else res(addresses ?? []);
      });
    });
    const lookup6 = new Promise<string[]>((res, rej) => {
      owned.resolve6(hostname, (err, addresses) => {
        if (err !== null) rej(err);
        else res(addresses ?? []);
      });
    });
    void Promise.allSettled([lookup4, lookup6]).then(([v4, v6]) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      owned.cancel();
      if (v4.status === 'fulfilled' || v6.status === 'fulfilled') {
        resolve([
          ...(v4.status === 'fulfilled' ? v4.value : []),
          ...(v6.status === 'fulfilled' ? v6.value : []),
        ]);
      } else {
        const first = v4.status === 'rejected' ? v4.reason : v6.reason;
        reject(first instanceof Error ? first : new Error(String(first)));
      }
    });
  });
}

function parseIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
  }
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  if (!parseIpv4(ip)) return false;
  const parts = ip.split('.').map(Number);
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return false;
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':');
}
