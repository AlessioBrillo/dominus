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

/**
 * Per-TLD origin overlap guard for the 2-of-2 consensus gate (ADR-0058).
 * The second opinion endpoint must not route through an origin that is
 * authoritative for the candidate's TLD — otherwise the second leg is a
 * rubber stamp of the primary's registry query and cannot catch a wrong
 * answer served by that origin. Authoritative origins are resolved at
 * runtime from the IANA bootstrap and exclude the bootstrap's universal
 * rdap.org fallback (it doubles as the default second leg, mirroring
 * validateRdapConsensusOriginDisjointness). An unparsable secondary
 * endpoint never flags (cannot prove overlap), mirroring rdapUrlOrigin's
 * stance on typos.
 */
export function hasAuthoritativeOriginOverlap(
  authoritativeOrigins: readonly string[],
  secondaryEndpoint: string,
): boolean {
  const secondaryOrigin = rdapUrlOrigin(secondaryEndpoint);
  if (secondaryOrigin === undefined) return false;
  // Normalize both sides to canonical origins so trailing slashes or path
  // differences on the authoritative entries cannot mask an overlap.
  return authoritativeOrigins.some((origin) => rdapUrlOrigin(origin) === secondaryOrigin);
}

/**
 * Runtime rubber-stamp guard for the 2-of-2 consensus gate (ADR-0050):
 * when the server that actually WON the primary race shares its origin with
 * the second opinion endpoint, the second leg would query the same place
 * that already answered — a "second opinion" that cannot catch a wrong
 * answer. This is the failure mode the static disjointness checks cannot
 * see: the primary's race includes the rdap.org universal fallback, which
 * also doubles as the default second leg, so a slow/unreachable registry
 * makes both legs hit rdap.org. The primary result carries the serving
 * origin (`RdapResult.sourceOrigin`); callers skip the second leg (counted
 * as origin overlap, downgraded unverifiable — fail-closed) when it equals
 * the secondary endpoint's origin. An unparsable either side never flags
 * (cannot prove overlap), mirroring rdapUrlOrigin's stance on typos.
 */
export function hasWinningOriginOverlap(
  primaryOrigin: string | undefined,
  secondaryEndpoint: string,
): boolean {
  if (primaryOrigin === undefined) return false;
  const secondaryOrigin = rdapUrlOrigin(secondaryEndpoint);
  if (secondaryOrigin === undefined) return false;
  return rdapUrlOrigin(primaryOrigin) === secondaryOrigin;
}
