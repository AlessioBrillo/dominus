// SPDX-License-Identifier: AGPL-3.0-only
import { resolve4, resolve6, resolveCname, resolveNs } from 'node:dns/promises';
import type { PublicDelegationReader } from '../../types/dns-write.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

/** Errors raised by the node resolver for "no such record / no data". */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code?: string }).code === 'ENOTFOUND' ||
      (err as { code?: string }).code === 'ENODATA')
  );
}

/**
 * Public-delegation reader over the system resolver (ADR-0083, M3).
 *
 * The independent leg of the DNS write gate: it answers "what does the
 * public DNS say the domain is delegated to and resolving to", without
 * any connection to the write provider. Every method returns null when
 * the resolver cannot answer — the gate treats null as "cannot
 * corroborate" and fails closed (ADR-0002).
 */
export class NodeDelegationReader implements PublicDelegationReader {
  readonly name = 'node-dns';

  async resolveNameservers(domain: string): Promise<string[] | null> {
    try {
      const servers = await resolveNs(domain);
      const normalised = servers.map((ns) => ns.trim().replace(/\.$/, '').toLowerCase());
      return normalised.length > 0 ? normalised : null;
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn({ domain, err }, 'NodeDelegationReader: NS resolution failed');
      }
      return null;
    }
  }

  async resolveAddresses(domain: string): Promise<string[] | null> {
    const addresses: string[] = [];
    try {
      addresses.push(...(await resolve4(domain)));
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn({ domain, err }, 'NodeDelegationReader: A resolution failed');
      }
    }
    try {
      addresses.push(...(await resolve6(domain)));
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn({ domain, err }, 'NodeDelegationReader: AAAA resolution failed');
      }
    }
    return addresses.length > 0 ? addresses : null;
  }

  async resolveCanonicalName(domain: string): Promise<string | null> {
    try {
      const targets = await resolveCname(domain);
      const first = targets[0];
      return first !== undefined ? first.trim().replace(/\.$/, '').toLowerCase() : null;
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn({ domain, err }, 'NodeDelegationReader: CNAME resolution failed');
      }
      return null;
    }
  }
}
