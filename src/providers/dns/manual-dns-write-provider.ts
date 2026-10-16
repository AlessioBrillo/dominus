// SPDX-License-Identifier: AGPL-3.0-only
import type {
  DnsRecord,
  DnsWriteOutcome,
  DnsWriteProvider,
  DnsZoneState,
} from '../../types/dns-write.js';

/**
 * Manual DNS write provider — the default and the honest fallback
 * (ADR-0083, M3; ADR-0082: never declare automation that does not exist).
 *
 * It performs no write. `ensureRecords` refuses loudly so the step can
 * never pretend a delegation happened, and `delegationInstructions`
 * produces the exact change the operator must make by hand at their
 * registrar/DNS panel — recorded in the step journal so the manual work
 * is as auditable as the automated one.
 */
export class ManualDnsWriteProvider implements DnsWriteProvider {
  readonly name = 'manual';

  /** Always false: there is nothing to automate here. */
  readonly isAvailable = false;

  async readZoneState(_domain: string): Promise<DnsZoneState | null> {
    // The manual provider has no view into any zone. The gate treats a
    // null state as "not managed" and skips with instructions.
    return null;
  }

  async ensureRecords(_domain: string, _records: DnsRecord[]): Promise<DnsWriteOutcome> {
    throw new Error(
      'ManualDnsWriteProvider cannot write DNS records: configure DNS_WRITE_PROVIDER=cloudflare or delegate manually',
    );
  }

  /** Human-readable instructions for the operator, one line per record. */
  delegationInstructions(domain: string, records: DnsRecord[]): string[] {
    return records.map((r) => {
      const name = r.name === '@' || r.name === '' ? domain : `${r.name}.${domain}`;
      return `Create/update ${r.type} record for ${name} → ${r.content}`;
    });
  }
}
