import type { SignalOutput, ScoringInput } from '../../types/score.js';
import type { ExpirySignalConfig } from '../scoring-config.js';
import { DEFAULT_EXPIRY_CONFIG } from '../scoring-config.js';

export function computeExpiryScore(
  input: ScoringInput,
  weight: number,
  config: ExpirySignalConfig = DEFAULT_EXPIRY_CONFIG,
): SignalOutput {
  if (!input.isCloseout) {
    return { score: 0, weight, details: { isCloseout: false } };
  }

  const ageScore =
    input.domainAge !== undefined ? Math.min(1, input.domainAge / config.maxAgeYears) : 0;

  const backlinkScore =
    input.backlinks !== undefined ? Math.min(1, input.backlinks / config.maxBacklinks) : 0;

  const waybackScore =
    input.waybackSnapshots !== undefined
      ? Math.min(1, input.waybackSnapshots / config.maxWaybackSnapshots)
      : 0;

  const score = Math.min(1, Math.max(0, ageScore * 0.4 + backlinkScore * 0.4 + waybackScore * 0.2));

  return {
    score,
    weight,
    details: {
      isCloseout: true,
      domainAge: input.domainAge,
      backlinks: input.backlinks,
      waybackSnapshots: input.waybackSnapshots,
      ageScore,
      backlinkScore,
      waybackScore,
    },
  };
}
