// SPDX-License-Identifier: AGPL-3.0-only
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getLogger } from '../../logger.js';

const logger = getLogger();

/** Split a `DNS_UNBOUND_HOSTS` entry into host and optional port. */
export function parseHostPort(entry: string): { host: string; port?: number } {
  const trimmed = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    const host = bracketed[1]!;
    const port = bracketed[2] !== undefined ? Number(bracketed[2]) : undefined;
    return port !== undefined ? { host, port } : { host };
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [host = '', portRaw = ''] = trimmed.split(':');
    if (host === '' || portRaw === '' || !/^\d+$/.test(portRaw)) {
      throw new Error(
        `Invalid Unbound host entry '${entry}': expected 'host', 'host:port', '[ipv6]' or '[ipv6]:port'.`,
      );
    }
    return { host, port: Number(portRaw) };
  }
  if (trimmed === '') {
    throw new Error(
      `Invalid Unbound host entry '${entry}': expected 'host', 'host:port', '[ipv6]' or '[ipv6]:port'.`,
    );
  }
  return { host: trimmed };
}

/** Recombine an IP literal with an optional port for `setServers`. */
function joinHostPort(address: string, port?: number): string {
  const wrapped = address.includes(':') ? `[${address}]` : address;
  return port !== undefined ? `${wrapped}:${port}` : wrapped;
}

/**
 * Resolve `DNS_UNBOUND_HOSTS` entries to IP literals for `node:dns`.
 *
 * `Resolver.setServers` accepts IP literals only — a Docker service name
 * such as `unbound:5300` throws `ERR_INVALID_IP_ADDRESS` at construction
 * and the process never boots. Hostnames are resolved once here (via the
 * system resolver, e.g. compose embedded DNS) before any `UnboundResolver`
 * is constructed. IP literals pass through untouched.
 *
 * Fail-closed: an unresolvable hostname throws with an actionable message
 * instead of booting against a silently dropped resolver leg.
 */
export async function resolveUnboundHosts(entries: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const entry of entries) {
    const { host, port } = parseHostPort(entry);
    if (isIP(host) !== 0) {
      resolved.push(joinHostPort(host, port));
      continue;
    }
    let address: string;
    try {
      ({ address } = await lookup(host));
    } catch (err) {
      throw new Error(
        `Cannot resolve Unbound host '${host}' (from '${entry}'): ` +
          'set DNS_UNBOUND_HOSTS to reachable IPs or fix service discovery.',
        { cause: err },
      );
    }
    logger.info({ host, address, port }, 'Resolved Unbound hostname to IP');
    resolved.push(joinHostPort(address, port));
  }
  return resolved;
}
