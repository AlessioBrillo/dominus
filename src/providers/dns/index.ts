// SPDX-License-Identifier: AGPL-3.0-only
export type { DnsProvider, DnsLookupSpec, DnsResolverGroup } from './dns-provider.js';
export { strategyToResolverGroups, collectResolverEndpoints } from './dns-provider.js';
export { NodeDnsProvider } from './node-dns-provider.js';
export type { DnsLookupStrategy } from './node-dns-provider.js';
export { DohAgentPool } from './doh-agents.js';
export type { DohAgentPoolOptions } from './doh-agents.js';
export { ParkingIpRegistry } from './parking-ip-registry.js';
export type { ParkingRange } from './parking-ip-registry.js';
export {
  validateResolverGroups,
  validateConsensusEndpointDisjointness,
} from './resolver-validator.js';
