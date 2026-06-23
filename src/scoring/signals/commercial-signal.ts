import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { SignalOutput, ScoringInput } from '../../types/score.js';
import type { CommercialSignalConfig } from '../scoring-config.js';
import { DEFAULT_COMMERCIAL_CONFIG } from '../scoring-config.js';

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
