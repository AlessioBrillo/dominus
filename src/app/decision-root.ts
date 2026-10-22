// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../config.js';
import { createKeywordProvider } from '../providers/keyword/index.js';
import { createCompsProvider } from '../providers/comps/index.js';
import type { ScoringEngine, ScoringWeights } from '../scoring/index.js';
import type { TrademarkGate } from '../trademark/index.js';
import { buildScoringEngine } from './scoring-factory.js';
import { buildTrademarkGate, buildTrademarkSources } from './trademark-stack.js';
import { warnEuipoIfMissing } from './provider-status.js';

/**
 * The decision dependencies: everything a single decision needs, and
 * nothing else.
 *
 * A decision (score one domain, clear it against the trademark gate) is a
 * pure computation over public data. It needs no database, no job queue,
 * no worker, no resolver and no RDAP bootstrap. The full composition root
 * provides all of that because the pipeline and the portfolio need it - and
 * a user who runs `dominus score example.com` used to pay for all of it:
 * the command created a SQLite database with its migrations, started the
 * job worker, waited for an Unbound resolver that a scoring command never
 * asks for and printed fourteen kilobytes of JSON log on stdout.
 *
 * This root is the answer to that: the smallest set that can produce the
 * answer, with the same providers and the same engine as the server. The
 * only difference is what is NOT built.
 */
export interface DecisionDependencies {
  engine: ScoringEngine;
  currentWeights: ScoringWeights;
  gate: TrademarkGate;
}

export function createDecisionDependencies(config: Config): DecisionDependencies {
  // The raw providers, not the cached ones: a one-shot command has no
  // second call to cache for, and the cache is a database table. The
  // provider implementations are the same.
  const keywordProvider = createKeywordProvider(
    config.KEYWORD_PROVIDER,
    {
      dataFilePath: config.KEYWORD_DATA_PATH,
      googleAdsClientId: config.GOOGLE_ADS_CLIENT_ID,
      googleAdsClientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
      googleAdsRefreshToken: config.GOOGLE_ADS_REFRESH_TOKEN,
      googleAdsDeveloperToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
      googleAdsCustomerId: config.GOOGLE_ADS_CUSTOMER_ID,
    },
    undefined,
  );

  const compsProvider = createCompsProvider(config.COMPS_PROVIDER, {
    csvFilePath: config.COMPS_DATA_PATH,
    namebioApiKey: config.NAMEBIO_API_KEY,
  });

  const { engine, currentWeights } = buildScoringEngine(keywordProvider, compsProvider, config);

  // The trademark gate is not optional (Principle 6): a domain that has not
  // been checked against the registers does not get a buy recommendation.
  const sources = buildTrademarkSources(config);
  const gate = buildTrademarkGate(config, sources.uspto, sources.euipo);

  warnEuipoIfMissing(config);

  return { engine, currentWeights, gate };
}
