// SPDX-License-Identifier: AGPL-3.0-only
import { PriorityRateLimiter, type RateLimiterLike } from '../providers/rate-limiter.js';

/**
 * The in-process rate limiter.
 *
 * It is extracted from `provider-factory.ts` so that a caller which needs a
 * limiter but not the whole provider factory does not have to import it: the
 * provider factory pulls in the DNS, RDAP and Redis stacks, and a decision
 * command must not pay for modules it never uses.
 *
 * The Redis-backed limiter (shared across replicas) stays in the provider
 * factory: it is a server concern, and it drags in the Redis client.
 */
export function buildLocalRateLimiter(tokens: number, intervalMs: number): RateLimiterLike {
  return new PriorityRateLimiter({ maxTokens: tokens, tokensPerInterval: tokens, intervalMs }, 0);
}
