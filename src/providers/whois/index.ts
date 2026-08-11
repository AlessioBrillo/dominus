// SPDX-License-Identifier: AGPL-3.0-only
export type { WhoisProvider, WhoisResult } from './whois-provider.js';
export {
  NodeWhoisProvider,
  NodeWhoisProviderWithIanaFallback,
  buildPerTldWhoisRateLimiters,
  parseWhoisRateLimitOverrides,
} from './node-whois-provider.js';
export type { NodeWhoisProviderConfig } from './node-whois-provider.js';
export { resolveWhoisServer, clearIanaCache } from './iana-server-lookup.js';
