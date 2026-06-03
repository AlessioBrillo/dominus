import type { SignalOutput, ScoringInput } from '../../types/score.js';

const MAX_AGE_YEARS = 20;
const MAX_BACKLINKS = 1000;
const MAX_WAYBACK_SNAPSHOTS = 500;

export function computeExpiryScore(input: ScoringInput, weight: number): SignalOutput {
  if (!input.isCloseout) {
    return { score: 0, weight, details: { isCloseout: false } };
  }

  const ageScore = input.domainAge !== undefined
    ? Math.min(1, input.domainAge / MAX_AGE_YEARS)
    : 0;

  const backlinkScore = input.backlinks !== undefined
    ? Math.min(1, input.backlinks / MAX_BACKLINKS)
    : 0;

  const waybackScore = input.waybkackSnapshots !== undefined
    ? Math.min(1, input.waybkackSnapshots / MAX_WAYBACK_SNAPSHOTS)
    : 0;

  const score = Math.min(1, Math.max(0, ageScore * 0.4 + backlinkScore * 0.4 + waybackScore * 0.2));

  return {
    score,
    weight,
    details: {
      isCloseout: true,
      domainAge: input.domainAge,
      backlinks: input.backlinks,
      waybkackSnapshots: input.waybkackSnapshots,
      ageScore,
      backlinkScore,
      waybackScore,
    },
  };
}
