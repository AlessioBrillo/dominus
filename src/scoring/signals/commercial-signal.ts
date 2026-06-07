import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { SignalOutput, ScoringInput } from '../../types/score.js';

const MAX_VOLUME = 1_000_000;
const MAX_CPC = 50;

export async function computeCommercialScore(
  input: ScoringInput,
  provider: KeywordProvider,
  weight: number,
): Promise<SignalOutput> {
  const sld = input.sld;
  const metrics = await provider.getMetrics(sld);

  const volumeScore = Math.min(1, metrics.monthlySearchVolume / MAX_VOLUME);
  const cpcScore = Math.min(1, metrics.cpc / MAX_CPC);

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
