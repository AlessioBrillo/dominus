// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../config.js';
import {
  EuipoProvider,
  FailoverTrademarkProvider,
  TsdrTrademarkProvider,
  UsptoCasesProvider,
} from '../providers/trademark/index.js';
import type { TrademarkProvider } from '../providers/trademark/trademark-provider.js';
import type { RateLimiterLike } from '../providers/rate-limiter.js';
import {
  CircuitBreaker,
  EUIPO_CIRCUIT_BREAKER,
  USPTO_CIRCUIT_BREAKER,
  type ICircuitBreaker,
} from '../providers/circuit-breaker.js';
import { TrademarkGate } from '../trademark/index.js';
import type { TrademarkGateStats } from '../trademark/trademark-gate.js';
import { RetryingTrademarkProvider } from './retrying-trademark-provider.js';
import { buildLocalRateLimiter } from './rate-limiter-factory.js';

/**
 * The trademark provider stack, without the cache.
 *
 * The stack is the same everywhere - USPTO with its TSDR fallback, EUIPO,
 * each behind a retry policy and a circuit breaker - so it is built in one
 * place. The cache (a database table) and the shared Redis breaker are
 * server concerns and are layered on top by the composition root; the
 * decision path uses the stack as it is.
 */
export interface TrademarkSources {
  uspto: RetryingTrademarkProvider;
  euipo: RetryingTrademarkProvider;
  /**
   * The provider that talks to the USPTO endpoint. It carries the WAF
   * counters the metrics endpoint reports, and the stack hides it behind
   * the retry decorator - so it is handed out explicitly.
   */
  rawUspto: UsptoCasesProvider;
}

export interface TrademarkSourceOptions {
  usptoRateLimiter?: RateLimiterLike;
  euipoRateLimiter?: RateLimiterLike;
  /** A shared (Redis) breaker for the server; a local one otherwise. */
  usptoBreaker?: ICircuitBreaker;
  euipoBreaker?: ICircuitBreaker;
}

export function buildTrademarkSources(
  config: Config,
  options: TrademarkSourceOptions = {},
): TrademarkSources {
  const usptoRateLimiter =
    options.usptoRateLimiter ??
    buildLocalRateLimiter(config.USPTO_RATE_LIMIT_TOKENS, config.USPTO_RATE_LIMIT_INTERVAL_MS);
  const euipoRateLimiter =
    options.euipoRateLimiter ??
    buildLocalRateLimiter(config.EUIPO_RATE_LIMIT_TOKENS, config.EUIPO_RATE_LIMIT_INTERVAL_MS);

  const rawUsptoProvider = new UsptoCasesProvider({
    searchUrl: config.USPTO_SEARCH_URL,
    rateLimiter: usptoRateLimiter,
  });

  const usptoFallbackProvider = new TsdrTrademarkProvider(
    config.USPTO_TSDR_SEARCH_URL,
    usptoRateLimiter,
  );

  const usptoFailoverProvider = new FailoverTrademarkProvider([
    rawUsptoProvider,
    usptoFallbackProvider,
  ]);

  const usptoBreaker = options.usptoBreaker ?? new CircuitBreaker(USPTO_CIRCUIT_BREAKER);
  const euipoBreaker = options.euipoBreaker ?? new CircuitBreaker(EUIPO_CIRCUIT_BREAKER);

  return {
    uspto: new RetryingTrademarkProvider(usptoFailoverProvider, {}, usptoBreaker),
    rawUspto: rawUsptoProvider,
    euipo: new RetryingTrademarkProvider(
      new EuipoProvider({
        clientId: config.EUIPO_CLIENT_ID,
        clientSecret: config.EUIPO_CLIENT_SECRET,
        authUrl: config.EUIPO_AUTH_URL,
        apiUrl: config.EUIPO_API_URL,
        pageSize: config.EUIPO_PAGE_SIZE,
        maxPages: config.EUIPO_MAX_PAGES,
        rateLimiter: euipoRateLimiter,
      }),
      {},
      euipoBreaker,
    ),
  };
}

/**
 * The trademark gate (Principle 6: no buy recommendation without a
 * trademark check).
 *
 * The gate is built over the providers it is given, so the server can hand
 * it the cached ones and the decision path the raw ones: the gate's
 * behaviour is identical, only the cache in front of it differs.
 */
export function buildTrademarkGate(
  config: Config,
  uspto: TrademarkProvider,
  euipo: TrademarkProvider,
  onResult?: (stats: TrademarkGateStats) => void,
): TrademarkGate {
  const matchDetectorConfig = {
    minTokenLengthForFuzzy: config.TRADEMARK_MIN_TOKEN_LENGTH_FUZZY,
    minMarkTokenLengthForSubstring: config.TRADEMARK_MIN_MARK_TOKEN_LENGTH_SUBSTRING,
    maxLevenshteinDistance: config.TRADEMARK_MAX_LEVENSHTEIN,
  };
  return new TrademarkGate(uspto, euipo, matchDetectorConfig, {
    providerTimeoutMs: config.TRADEMARK_PROVIDER_TIMEOUT_MS,
    ...(onResult ? { onResult } : {}),
  });
}
