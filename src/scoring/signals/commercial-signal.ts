import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { SignalOutput, ScoringInput } from '../../types/score.js';
import type { CommercialSignalConfig } from '../scoring-config.js';
import { DEFAULT_COMMERCIAL_CONFIG } from '../scoring-config.js';

export async function computeCommercialScore(
  input: ScoringInput,
  provider: KeywordProvider,
  weight: number,
  config: CommercialSignalConfig = DEFAULT_COMMERCIAL_CONFIG,
): Promise<SignalOutput> {
  const sld = input.sld;
  const metrics = await provider.getMetrics(sld);

  const volumeScore = Math.min(1, metrics.monthlySearchVolume / config.maxVolume);
  const cpcScore = Math.min(1, metrics.cpc / config.maxCpc);

  const score = Math.min(1, Math.max(0, volumeScore * 0.6 + cpcScore * 0.4));

  return {
    score,
    weight,
    details: {
      term: sld,
      monthlySearchVolume: metrics.monthlySearchVolume,
      cpc: metrics.cpc,
      volumeScore,
      cpcScore,
    },
  };
}
