// SPDX-License-Identifier: AGPL-3.0-only
import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { SignalOutput, ScoringInput } from '../../types/score.js';
import type { CommercialSignalConfig } from '../scoring-config.js';
import { DEFAULT_COMMERCIAL_CONFIG } from '../scoring-config.js';
import { getLogger } from '../../logger.js';
import type { MetricsCollector } from '../../app/metrics-collector.js';

const logger = getLogger();
let commercialSignalProviderWarned = false;

export async function computeCommercialScore(
  input: ScoringInput,
  provider: KeywordProvider,
  weight: number,
  config: CommercialSignalConfig = DEFAULT_COMMERCIAL_CONFIG,
  signal?: AbortSignal,
  metrics?: MetricsCollector,
): Promise<SignalOutput> {
  // Engine always sets sld before calling signal functions;
  // non-null assertion is safe here (see ScoringEngine.score()).
  const sld = input.sld!;
  let metricsData: {
    monthlySearchVolume: number;
    cpc: number;
    covered?: boolean | undefined;
    source?: string | undefined;
  };
  let providerError: string | undefined;

  try {
    metricsData = await provider.getMetrics(sld, signal);
  } catch (err) {
    providerError = err instanceof Error ? err.message : String(err);
    metricsData = { monthlySearchVolume: 0, cpc: 0, covered: false };
  }

  // Coverage is about provenance, not magnitude: curated measurements are
  // full coverage, keyword-suggest estimates are partial, a missing answer
  // is none. It is carried into signalStatus so a redistributed weight is
  // visible to the reader instead of being inferred from a zero score.
  const estimatedSource =
    metricsData.source === 'fallback' || metricsData.source === 'google-suggest';
  const coverage =
    metricsData.covered === false || providerError !== undefined
      ? 0
      : estimatedSource
        ? 0.5
        : metricsData.monthlySearchVolume > 0 || metricsData.cpc > 0
          ? 1
          : 0;

  // Warn once per process when the commercial signal has no measured data.
  // The weight is redistributed to intrinsic, so both the log and the
  // score's signalStatus now say that the number is weakly supported.
  if (
    !commercialSignalProviderWarned &&
    metricsData.monthlySearchVolume === 0 &&
    metricsData.cpc === 0
  ) {
    commercialSignalProviderWarned = true;
    logger.warn(
      {
        provider: provider.constructor.name,
        keywordProvider: process.env.KEYWORD_PROVIDER ?? 'google-suggest',
        coverage,
      },
      'Commercial signal: provider returned zero volume/CPC - commercial weight will be redistributed to intrinsic. ' +
        'Configure KEYWORD_PROVIDER=composite (with KEYWORD_DATA_PATH) or Google Ads credentials for real commercial data.',
    );
  }

  const volumeScore = Math.min(1, metricsData.monthlySearchVolume / config.maxVolume);
  const cpcScore = Math.min(1, metricsData.cpc / config.maxCpc);

  const score = Math.min(1, Math.max(0, volumeScore * 0.6 + cpcScore * 0.4));
  const dataAvailable = metricsData.monthlySearchVolume > 0 || metricsData.cpc > 0;

  // Emit metric for commercial signal data availability (for observability)
  if (metrics !== undefined) {
    metrics.recordCommercialSignal?.({
      dataAvailable,
      provider: provider.constructor.name,
    });
  }

  return {
    score,
    weight,
    dataAvailable,
    providerError,
    details: {
      term: sld,
      monthlySearchVolume: metricsData.monthlySearchVolume,
      cpc: metricsData.cpc,
      coverage,
      ...(metricsData.source ? { source: metricsData.source } : {}),
      volumeScore,
      cpcScore,
    },
  };
}
