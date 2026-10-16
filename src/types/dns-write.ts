// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DNS write layer types (ADR-0083, M3).
 *
 * The `dns` step of the post-acquisition pipeline is the first step that
 * mutates external state a visitor's traffic depends on, so the write path
 * reuses the read path's fail-closed reasoning (ADR-0002, ADR-0083
 * amendment 2026-10-14): before deciding what to write, the gate must
 * reach an independently corroborated conclusion about what the current
 * state *is*, and a write that half-completes must leave the domain in a
 * recoverable, named state in the journal.
 */

export type DnsRecordType = 'A' | 'CNAME' | 'NS' | 'TXT';

export interface DnsRecord {
  type: DnsRecordType;
  /** Record name relative to the zone: '@' for the apex. */
  name: string;
  content: string;
  ttl?: number;
}

/** What the write provider reports about the zone of a domain. */
export interface DnsZoneState {
  domain: string;
  /** True when the domain's zone is managed by this write provider. */
  managed: boolean;
  records: DnsRecord[];
  /** Nameservers the provider expects the domain to be delegated to. */
  expectedNameServers: string[];
}

export interface DnsWriteOutcome {
  domain: string;
  /** False when the provider performed a simulation (dry-run). */
  applied: boolean;
  /** Records that exist after the call (applied or confirmed present). */
  records: DnsRecord[];
  changed: DnsRecord[];
  message?: string;
}

/**
 * Write side of the DNS step (ADR-0004: provider-agnostic abstraction).
 * Implementations: CloudflareDnsWriteProvider (API writes),
 * ManualDnsWriteProvider (no automation — instructions only).
 */
export interface DnsWriteProvider {
  readonly name: string;
  /** False when the provider is not configured: the step must skip honestly. */
  readonly isAvailable: boolean;
  /**
   * Current zone state from the provider's own view, or null when the
   * zone is not managed. MUST throw ProviderError when the provider
   * cannot answer with certainty — uncertainty is never a state.
   */
  readZoneState(domain: string): Promise<DnsZoneState | null>;
  /**
   * Idempotently ensure the target records exist. A re-run with the same
   * records must be a no-op that reports no changes.
   */
  ensureRecords(domain: string, records: DnsRecord[]): Promise<DnsWriteOutcome>;
}

/**
 * Independent read of the public delegation (the corroboration leg of the
 * write gate). Implemented once over a public resolver; business logic
 * never touches a resolver directly (Principle 1).
 */
export interface PublicDelegationReader {
  readonly name: string;
  /**
   * NS records of the domain as seen from public DNS, normalised to
   * lowercase without a trailing dot. Null when unresolvable — the gate
   * treats null as "cannot corroborate" and fails closed.
   */
  resolveNameservers(domain: string): Promise<string[] | null>;
  /** Addresses the apex currently resolves to. Null when unresolvable. */
  resolveAddresses(domain: string): Promise<string[] | null>;
  /** CNAME target of the apex, when present. Null otherwise. */
  resolveCanonicalName(domain: string): Promise<string | null>;
}

/** Target state the `dns` step drives the domain towards. */
export interface DnsDelegationTarget {
  type: 'A' | 'CNAME';
  /** A-record IP or CNAME hostname of the parking provider. */
  value: string;
  /** Record name, '@' (apex) by default. */
  recordName?: string;
}

/** Why the gate skipped instead of writing. */
export type DnsSkipReason =
  | 'dns_write_provider_unavailable'
  | 'zone_not_managed'
  | 'delegation_mismatch'
  | 'target_not_configured'
  | 'delegation_unverifiable'
  | 'dry_run';

export type DnsGateVerdict =
  | { action: 'write'; target: DnsRecord[]; expectedNameServers: string[] }
  | { action: 'done'; reason: 'already_delegated'; records: DnsRecord[] }
  | { action: 'skip'; reason: DnsSkipReason; detail?: Record<string, unknown> };
