// SPDX-License-Identifier: AGPL-3.0-only
import type { RdapBootstrapUrlEntry } from './failover-rdap-provider.js';

export interface OriginDisjointnessResult {
  ok: boolean;
  /** The overlapping origin when ok is false. */
  overlap?: string;
}

/**
 * Normalize an RDAP origin URL for comparison.
 * - Strips trailing slash
 * - Removes default port (443 for https)
 * - Normalizes IPv6 bracket notation
 * - Lowercases hostname
 * This ensures that 'https://rdap.verisign.com', 'https://rdap.verisign.com/',
 * 'https://rdap.verisign.com:443', and 'https://[2001:db8::1]:443/' all
 * compare as equal.
 */
export function normalizeRdapOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    // URL.origin already gives us 'protocol://host:port' but with some quirks:
    // - IPv6 hosts are bracketed: 'https://[::1]:5300'
    // - Default ports (443 for https, 80 for http) are omitted
    // - Trailing slashes in path are not part of origin
    let origin = parsed.origin;

    // Normalize IPv6: ensure brackets are present for IPv6 literals
    // URL.origin already does this correctly for standard IPv6

    // Ensure lowercase for case-insensitive hostname comparison
    return origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Canonical origin of an RDAP endpoint URL (protocol + host), used to compare
 * "are these two servers the same place?" without being fooled by path
 * differences (https://rdap.org/ vs https://rdap.org/domain/). Unparsable
 * URLs yield undefined — callers treat that as "cannot prove overlap" rather
 * than failing closed on a typo.
 */
export function rdapUrlOrigin(url: string): string | undefined {
  return normalizeRdapOrigin(url);
}

/**
 * Collect and normalize RDAP origins from bootstrap entries.
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
  // Normalize primary origins for comparison (they may come from config directly)
  const normalizedPrimaryOrigins = primaryOrigins.map((o) => rdapUrlOrigin(o)).filter((o): o is string => o !== undefined);
  const overlap = normalizedPrimaryOrigins.find((origin) => origin === secondaryOrigin);
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
  // Normalize both sides to canonical origins so trailing slashes, default ports,
  // or IPv6 bracket differences on the authoritative entries cannot mask an overlap.
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
