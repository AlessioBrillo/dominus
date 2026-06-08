import type { SignalOutput, ScoringInput } from '../../types/score.js';
import { PREMIUM_TLD_BONUS } from '../weights.js';

const IDEAL_LENGTH = 7;
const MAX_LENGTH = 20;

export function computeIntrinsicScore(input: ScoringInput, weight: number): SignalOutput {
  // SLD is supplied by the caller (via parseDomain). For multi-part TLDs
  // reconstructing it from `input.domain.replace(input.tld, '')` would
  // leave the public-suffix prefix in the SLD (e.g. 'nike.co' for
  // nike.co.uk). The canonical SLD is the caller's responsibility.
  const sld = input.sld;
  const length = sld.length;

  const lengthScore =
    length <= IDEAL_LENGTH
      ? 1.0
      : Math.max(0, 1 - (length - IDEAL_LENGTH) / (MAX_LENGTH - IDEAL_LENGTH));

  const hyphenCount = (sld.match(/-/g) ?? []).length;
  const digitCount = (sld.match(/[0-9]/g) ?? []).length;
  const penaltyScore = Math.max(0, 1 - hyphenCount * 0.25 - digitCount * 0.15);

  const tldMultiplier = PREMIUM_TLD_BONUS[input.tld] ?? 0.3;

  const pronounceabilityScore = computePronouncability(sld);

  const raw =
    (lengthScore * 0.3 + penaltyScore * 0.35 + pronounceabilityScore * 0.35) * tldMultiplier;
  const score = Math.min(1, Math.max(0, raw));

  return {
    score,
    weight,
    details: {
      sld,
      length,
      hyphenCount,
      digitCount,
      lengthScore,
      penaltyScore,
      pronounceabilityScore,
      tldMultiplier,
    },
  };
}

function computePronouncability(sld: string): number {
  if (sld.length === 0) return 0;

  const vowels = new Set(['a', 'e', 'i', 'o', 'u']);
  let vowelCount = 0;
  let consonantClusterLength = 0;
  let maxCluster = 0;

  for (const char of sld.toLowerCase()) {
    if (vowels.has(char)) {
      vowelCount++;
      consonantClusterLength = 0;
    } else if (/[a-z]/.test(char)) {
      consonantClusterLength++;
      maxCluster = Math.max(maxCluster, consonantClusterLength);
    }
  }

  const vowelRatio = vowelCount / sld.length;
  const clusterPenalty = Math.max(0, (maxCluster - 3) * 0.2);
  const score = Math.min(1, Math.max(0, vowelRatio * 2 - clusterPenalty));
  return score;
}
