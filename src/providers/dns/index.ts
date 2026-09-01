// SPDX-License-Identifier: AGPL-3.0-only
export type {
  DnsProvider,
  DnsLookupSpec,
  DnsResolverGroup,
  DnsConsensusValidationResult,
  AnycastOverlapDetail,
  ResolvedEndpoint,
  ResolveEndpointsLiveResult,
  ResolvedEndpoints,
} from './dns-provider.js';
export {
  strategyToResolverGroups,
  collectResolverEndpoints,
  validateConsensusDisjointnessRuntime,
  resolveEndpointsLiveWithAnycast,
} from './dns-provider.js';
export { NodeDnsProvider } from './node-dns-provider.js';
export type {
  DnsLookupStrategy,
  DnsLegSample,
  DnsLegTelemetry,
  DnsLegVerdict,
} from './node-dns-provider.js';
export { DohAgentPool } from './doh-agents.js';
export type { DohAgentPoolOptions } from './doh-agents.js';
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
  validateResolverGroups,
  validateConsensusEndpointDisjointness,
  validateConsensusDisjointness,
  validateFallbackIsolation,
  type ConsensusDisjointnessReport,
  type FallbackIsolationReport,
} from './resolver-validator.js';
export {
  AuthoritativeZoneResolver,
  createAuthoritativeZoneResolver,
  checkAuthoritativeZoneOverlap,
} from './authoritative-zone-resolver.js';
export { ConsensusDnsProvider } from './consensus-dns-provider.js';
export type {
  DisjointnessValidator,
  ConsensusConfig,
  ConsensusDnsProviderOptions,
  TertiaryDnsConfig,
} from './consensus-dns-provider.js';
