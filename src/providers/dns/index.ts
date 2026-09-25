// SPDX-License-Identifier: AGPL-3.0-only
export type { DnsProvider, DnsCheckOptions, DnsCheckResult } from './dns-provider.js';
export { ParkingIpRegistry } from './parking-ip-registry.js';
export type { ParkingRange } from './parking-ip-registry.js';
export {
  DnsBreakerRegistry,
  DNS_BREAKER_POLICY,
  dnsBreakerKey,
  type DnsBreakerRegistryLike,
  type DnsBreakerStats,
} from './dns-breaker.js';
export {
  UnboundResolver,
  type UnboundResolverOptions,
  type UnboundHostDnssecResult,
  DNSSEC_POSITIVE_CONTROLS,
  DNSSEC_NEGATIVE_CONTROL,
} from './unbound-resolver.js';
export { validateDnssecPerQuery, type DnssecValidationResult } from './dnssec-validation.js';
export { NodeDnsFallback, type NodeDnsFallbackOptions } from './node-dns-fallback.js';
