// SPDX-License-Identifier: AGPL-3.0-only
export type { DnsProvider, DnsLookupSpec, DnsResolverGroup } from './dns-provider.js';
export {
  strategyToResolverGroups,
  getDefaultDohProviders,
  getDefaultDotProviders,
} from './dns-provider.js';
export { NodeDnsProvider } from './node-dns-provider.js';
export type { DnsLookupStrategy } from './node-dns-provider.js';
export { ParkingIpRegistry } from './parking-ip-registry.js';
export type { ParkingRange } from './parking-ip-registry.js';
export { validateResolverGroups } from './resolver-validator.js';
