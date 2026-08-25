// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../../logger.js';

const logger = getLogger();

/**
 * DNSSEC validation result for native resolver queries.
 * 'valid' = DNSSEC validation passed (AD flag set, chain verified)
 * 'bogus' = DNSSEC validation failed (bogus response, treated as Registered)
 * 'insecure' = Zone is not DNSSEC-signed (no validation possible)
 * 'unchecked' = DNSSEC validation not performed
 */
export type DnssecStatus = 'valid' | 'bogus' | 'insecure' | 'unchecked';

/**
 * Perform DNSSEC validation for a domain using the native resolver with
 * pinned nameservers.
 *
 * This is called when:
 * - DNS_NATIVE_DNSSEC_ENABLED=true
 * - Custom nameservers are configured (DNS_NAMESERVERS, DNS_CONSENSUS_NAMESERVERS, or DNS_TERTIARY_NAMESERVERS)
 * - The native resolver path is being used
 *
 * The native Node.js resolver doesn't support DNSSEC (no DO bit, no AD flag).
 * When DNSSEC validation is required on native path, the operator should use
 * DoH/DoT paths which support full DNSSEC validation.
 *
 * This function logs a warning and returns 'unchecked' as a placeholder.
 * Full implementation would require a custom DNSSEC-aware resolver or using
 * DoH wire format to the same recursor.
 */
export async function validateDnssecNative(
  _domain: string,
  _nameservers: string[],
): Promise<DnssecStatus> {
  logger.warn(
    { _domain, _nameservers },
    'DNS: native resolver DNSSEC validation not fully implemented — ' +
      'falling back to unchecked. Use DoH/DoT for full DNSSEC validation.',
  );

  return 'unchecked';
}
