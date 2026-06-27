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
}
