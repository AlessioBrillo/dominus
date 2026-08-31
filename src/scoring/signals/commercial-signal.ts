// SPDX-License-Identifier: AGPL-3.0-only
import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { SignalOutput, ScoringInput } from '../../types/score.js';
import type { CommercialSignalConfig } from '../scoring-config.js';
import { DEFAULT_COMMERCIAL_CONFIG } from '../scoring-config.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();
let commercialSignalProviderWarned = false;

export async function computeCommercialScore(
  input: ScoringInput,
  provider: KeywordProvider,
  weight: number,
  config: CommercialSignalConfig = DEFAULT_COMMERCIAL_CONFIG,
  signal?: AbortSignal,
): Promise<SignalOutput> {
  // Engine always sets sld before calling signal functions;
  // non-null assertion is safe here (see ScoringEngine.score()).
  const sld = input.sld!;
  let metrics: { monthlySearchVolume: number; cpc: number };
  let providerError: string | undefined;

  try {
    metrics = await provider.getMetrics(sld, signal);
  } catch (err) {
    providerError = err instanceof Error ? err.message : String(err);
    metrics = { monthlySearchVolume: 0, cpc: 0 };
  }

  // Warn once per process if the commercial signal provider returns no
  // volume/CPC data (e.g. GoogleSuggestKeywordProvider). The commercial
  // signal weight will be redistributed to intrinsic, biasing scores.
  // In community edition, set KEYWORD_PROVIDER=manual with a data file
  // (KEYWORD_DATA_PATH) or configure Google Ads credentials for real data.
  if (!commercialSignalProviderWarned && metrics.monthlySearchVolume === 0 && metrics.cpc === 0) {
    commercialSignalProviderWarned = true;
    logger.warn(
      {
        provider: provider.constructor.name,
        keywordProvider: process.env.KEYWORD_PROVIDER ?? 'google-suggest',
      },
      'Commercial signal: provider returned zero volume/CPC — commercial weight will be redistributed to intrinsic. ' +
        'Configure KEYWORD_PROVIDER=manual with KEYWORD_DATA_PATH or Google Ads credentials for real commercial data.',
    );
  }

  const volumeScore = Math.min(1, metrics.monthlySearchVolume / config.maxVolume);
  const cpcScore = Math.min(1, metrics.cpc / config.maxCpc);

  const score = Math.min(1, Math.max(0, volumeScore * 0.6 + cpcScore * 0.4));
  const dataAvailable = metrics.monthlySearchVolume > 0 || metrics.cpc > 0;

  return {
    score,
    weight,
    dataAvailable,
    providerError,
    details: {
      term: sld,
      monthlySearchVolume: metrics.monthlySearchVolume,
      cpc: metrics.cpc,
      volumeScore,
      cpcScore,
    },
  };
}
