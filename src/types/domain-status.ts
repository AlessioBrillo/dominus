// SPDX-License-Identifier: AGPL-3.0-only
export enum DomainStatus {
  Available = 'available',
  Registered = 'registered',
  Premium = 'premium',
  Unknown = 'unknown',
  Error = 'error',
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
