// SPDX-License-Identifier: AGPL-3.0-only
import type {
  DnsDelegationTarget,
  DnsGateVerdict,
  DnsRecord,
  DnsWriteOutcome,
  DnsWriteProvider,
  PublicDelegationReader,
} from '../types/dns-write.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface DnsWriteGateOptions {
  writeProvider: DnsWriteProvider;
  /**
   * Independent public-DNS view. Without it the gate cannot corroborate
   * what the current state is and refuses to write (fail-closed, ADR-0083
   * amendment 2026-10-14).
   */
  reader?: PublicDelegationReader | undefined;
  /** Parking target from configuration. Absent = nothing to delegate to. */
  target?: DnsDelegationTarget | undefined;
}

/** Same set of nameservers, order-insensitive. */
function sameNameservers(actual: readonly string[], expected: readonly string[]): boolean {
  if (expected.length === 0) return false;
  const actualSet = new Set(actual);
  return expected.every((ns) => actualSet.has(ns));
}

/** Human-readable manual instructions, also recorded on skip. */
export function formatDelegationInstructions(
  domain: string,
  records: readonly DnsRecord[],
): string[] {
  return records.map((r) => {
    const name = r.name === '@' || r.name === '' ? domain : `${r.name}.${domain}`;
    return `Create/update ${r.type} record for ${name} -> ${r.content}`;
  });
}

/**
 * Fail-closed gate for DNS writes (ADR-0083 M3, amendment 2026-10-14).
 *
 * The write path reuses the read path's conservatism: before deciding what
 * to write, the gate reaches an independently corroborated conclusion
 * about what the current state *is* — the write provider's own view of
 * the zone plus a public-DNS read of the delegation. A write is only ever
 * performed when both legs agree, and it is confirmed publicly afterwards.
 * Anything else is a skip (recoverable, with instructions) or a failure
 * (named, resumable) — never a best-effort "probably applied".
 */
export class DnsWriteGate {
  readonly #writeProvider: DnsWriteProvider;
  readonly #reader: PublicDelegationReader | undefined;
  readonly #target: DnsDelegationTarget | undefined;

  constructor(options: DnsWriteGateOptions) {
    this.#writeProvider = options.writeProvider;
    this.#reader = options.reader;
    this.#target = options.target;
  }

  /** Records that encode the configured delegation target. */
  targetRecords(): DnsRecord[] {
    if (!this.#target) return [];
    return [
      {
        type: this.#target.type,
        name: this.#target.recordName ?? '@',
        content: this.#target.value,
      },
    ];
  }

  /**
   * Decide what to do for a domain. Throws ProviderError when the write
   * provider cannot answer with certainty — uncertainty must surface as a
   * step failure, never as a silent skip that masks a broken delegation.
   */
  async evaluate(domain: string): Promise<DnsGateVerdict> {
    if (!this.#writeProvider.isAvailable) {
      return { action: 'skip', reason: 'dns_write_provider_unavailable' };
    }
    if (!this.#target || this.#target.value.length === 0) {
      return { action: 'skip', reason: 'target_not_configured' };
    }

    const state = await this.#writeProvider.readZoneState(domain);
    if (state === null || !state.managed) {
      return { action: 'skip', reason: 'zone_not_managed' };
    }

    // Independent leg: what does public DNS say the delegation is?
    if (!this.#reader) {
      return { action: 'skip', reason: 'delegation_unverifiable' };
    }
    const publicNs = await this.#reader.resolveNameservers(domain);
    if (publicNs === null || publicNs.length === 0) {
      return {
        action: 'skip',
        reason: 'delegation_unverifiable',
        detail: { domain, reader: this.#reader.name },
      };
    }
    const expected = state.expectedNameServers;
    if (!sameNameservers(publicNs, expected)) {
      // The write would not take effect: the domain is not delegated to
      // the nameservers this provider controls.
      return {
        action: 'skip',
        reason: 'delegation_mismatch',
        detail: { domain, publicNameServers: publicNs, expectedNameServers: expected },
      };
    }

    if (await this.#targetIsLive(domain)) {
      return { action: 'done', reason: 'already_delegated', records: state.records };
    }

    logger.info({ domain }, 'DnsWriteGate: write required');
    return { action: 'write', target: this.targetRecords(), expectedNameServers: expected };
  }

  /** Perform the (idempotent) write. */
  async apply(domain: string): Promise<DnsWriteOutcome> {
    return this.#writeProvider.ensureRecords(domain, this.targetRecords());
  }

  /**
   * Confirm the write took effect from the public side. False when the
   * delegation still does not resolve to the target — the executor turns
   * that into a named, resumable failure.
   */
  async confirm(domain: string): Promise<boolean> {
    return this.#targetIsLive(domain);
  }

  /** Does the domain already resolve to the configured target? */
  async #targetIsLive(domain: string): Promise<boolean> {
    if (!this.#reader || !this.#target) return false;
    const value = this.#target.value.trim().replace(/\.$/, '').toLowerCase();

    if (this.#target.type === 'CNAME') {
      const cname = await this.#reader.resolveCanonicalName(domain);
      if (cname === null) return false;
      return cname.trim().replace(/\.$/, '').toLowerCase() === value;
    }

    const addresses = await this.#reader.resolveAddresses(domain);
    return addresses !== null && addresses.includes(this.#target.value);
  }
}
