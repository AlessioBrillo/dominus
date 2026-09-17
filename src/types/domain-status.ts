// SPDX-License-Identifier: AGPL-3.0-only
export enum DomainStatus {
  Available = 'available',
  Registered = 'registered',
  Premium = 'premium',
  Unknown = 'unknown',
  Error = 'error',
}

/**
 * VerdictProvenance captures the complete chain of evidence for an availability
 * verdict across DNS, RDAP, and Trademark stages. This enables full auditability
 * and debugging of false positives/negatives in the pipeline.
 */
export interface VerdictProvenance {
  /**
   * DNS resolution provenance from the pre-filter stage.
   */
  dns?: {
    /** Resolver endpoint that produced the verdict (e.g., "unbound:5300", "1.1.1.1"). */
    resolver: string;
    /** Transport protocol used for the query. */
    transport: 'DoT' | 'DoH' | 'native';
    /** DNSSEC validation status as reported by the resolver. */
    dnssec: 'valid' | 'bogus' | 'insecure' | 'unchecked';
    /** Query duration in milliseconds. */
    durationMs: number;
    /** Whether the result was served from cache. */
    fromCache: boolean;
  };

  /**
   * RDAP confirmation provenance including 2-of-2 consensus details.
   */
  rdap?: {
    /** Primary RDAP server that produced the initial verdict (e.g., "rdap.verisign.com"). */
    primaryServer: string;
    /** 2-of-2 consensus verification details, when the gate is enabled. */
    consensus?: {
      /** Second RDAP server consulted for consensus (e.g., "rdap.org"). */
      secondServer: string;
      /** Whether the second leg independently confirmed Available. */
      verified: boolean;
      /** Whether the second leg vetoed with Registered/Premium. */
      vetoed: boolean;
      /** Whether the second leg was skipped due to authoritative origin overlap (rubber-stamp guard). */
      originOverlap: boolean;
      /** Whether WHOIS rescue leg confirmed the verdict. */
      whoisRescued: boolean;
    };
    /** Total RDAP verification duration in milliseconds (primary + consensus). */
    durationMs: number;
  };

  /**
   * Trademark gate provenance from USPTO and EUIPO checks.
   */
  trademark?: {
    /** USPTO provider result. */
    uspto: { checked: boolean; durationMs: number; verdict: GateVerdict };
    /** EUIPO provider result. */
    euipo: { checked: boolean; durationMs: number; verdict: GateVerdict };
  };

  /** ISO-8601 timestamp when the provenance was recorded. */
  timestamp: string;
}

/**
 * Trademark gate verdict enum (re-exported for provenance typing).
 */
export enum GateVerdict {
  Clear = 'clear',
  Blocked = 'blocked',
  Unverified = 'unverified',
}

export interface DnsCheckResult {
  domain: string;
  status: DomainStatus;
  checkedAt: string;
  /**
   * When `true`, the domain resolved to an IP known to belong to a domain
   * parking service (GoDaddy, Sedo, Dan.com, etc.). The domain is technically
   * registered but may be available for purchase via the aftermarket.
   * Only populated when `DNS_PARKING_CHECK_ENABLED=true`. Undefined when
   * parking detection was not performed.
   */
  isParked?: boolean | undefined;
  /**
   * Human-readable name of the parking registrar detected (e.g. "GoDaddy").
   * Only set when `isParked === true`.
   */
  parkingRegistrar?: string | undefined;
  /**
   * DNSSEC validation status (ADR-0061). Semantics depend on the producing
   * provider:
   * - Wire-format validators with AD-flag access: 'valid' (AD=1, signatures
   *   verify), 'bogus' (invalid signatures, fail-closed), 'insecure' (zone
   *   not signed), 'unchecked' (DO=0 or disabled).
   * - `UnboundResolver`: `node:dns` exposes no per-query AD flag, so this is
   *   a resolver-level fact proven once at boot (see
   *   `UnboundResolver.healthCheck()`'s negative-control probe), not a
   *   per-domain wire-format result. Only 'valid' (validation proven active)
   *   or 'unchecked' (not proven, or disabled) are produced — 'bogus' is
   *   unreachable there because Unbound already fails a bogus answer closed
   *   with SERVFAIL, which surfaces as `DomainStatus.Unknown`; 'insecure' is
   *   unreachable because per-domain signed-vs-unsigned cannot be observed
   *   through this transport.
   */
  dnssec?: 'valid' | 'bogus' | 'insecure' | 'unchecked';
  /** Query duration in milliseconds, when the producing provider tracks it.
   *  Feeds `VerdictProvenance.dns.durationMs`. */
  durationMs?: number | undefined;
  /** Whether this result was served from a cache tier rather than a live
   *  query, when the producing provider tracks it. Feeds
   *  `VerdictProvenance.dns.fromCache`. */
  fromCache?: boolean | undefined;
}

export interface RdapResult {
  domain: string;
  status: DomainStatus;
  isPremium: boolean;
  registrar?: string;
  expiresAt?: string;
  checkedAt: string;
  rawResponse?: unknown;
  /**
   * Canonical origin (protocol + host) of the RDAP server that produced the
   * verdict, when known. Used by the 2-of-2 consensus gate to detect a
   * rubber stamp: when the primary race was won by the same origin as the
   * second leg, the "second opinion" is no opinion (ADR-0050).
   */
  sourceOrigin?: string;
}
