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
