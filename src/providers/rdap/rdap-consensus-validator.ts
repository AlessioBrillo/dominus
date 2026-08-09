// SPDX-License-Identifier: AGPL-3.0-only
import type { RdapBootstrapUrlEntry } from './failover-rdap-provider.js';

export interface OriginDisjointnessResult {
  ok: boolean;
  /** The overlapping origin when ok is false. */
  overlap?: string;
}

/**
 * Canonical origin of an RDAP endpoint URL (protocol + host), used to compare
 * "are these two servers the same place?" without being fooled by path
 * differences (https://rdap.org/ vs https://rdap.org/domain/). Unparsable
 * URLs yield undefined — callers treat that as "cannot prove overlap" rather
 * than failing closed on a typo.
 */
export function rdapUrlOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Unique origins of the operator-configured authoritative RDAP servers
 * (RDAP_BOOTSTRAP_URLS, ADR-0035). The IANA bootstrap (RFC 7484) registers
 * are resolved at runtime from dns.json, so they are not enumerable at
 * startup; this validates the statically known set plus the optional second
 * opinion endpoint.
 */
export function collectRdapOrigins(entries: readonly RdapBootstrapUrlEntry[]): string[] {
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = rdapUrlOrigin(entry.url);
    if (origin !== undefined) origins.add(origin);
  }
  return [...origins];
}

/**
 * Endpoint disjointness for the RDAP 2-of-2 consensus gate (ADR-0050 §2).
 * A second opinion routed through an origin the primary already queries is a
 * rubber stamp: it cannot catch a wrong 404 served by that origin. The
 * primary's own universal fallback (rdap.org) is deliberately NOT part of
 * the compared set: it doubles as the default second leg, and a registry
 * origin answering the primary is exactly the anomaly the gate exists to
 * catch. Custom RDAP_BOOTSTRAP_URLS entries that include the second
 * endpoint's origin disable the gate with a clear message (mirroring
 * validateConsensusEndpointDisjointness in the DNS layer, ADR-0040).
 */
export function validateRdapConsensusOriginDisjointness(
  primaryOrigins: readonly string[],
  secondaryEndpoint: string,
): OriginDisjointnessResult {
  const secondaryOrigin = rdapUrlOrigin(secondaryEndpoint);
  if (secondaryOrigin === undefined) {
    return { ok: false, overlap: secondaryEndpoint };
  }
  const overlap = primaryOrigins.find((origin) => origin === secondaryOrigin);
  if (overlap !== undefined) {
    return { ok: false, overlap: secondaryOrigin };
  }
  return { ok: true };
}
