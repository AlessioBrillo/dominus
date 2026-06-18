import type { SignalOutput, ScoringInput } from '../../types/score.js';
import { DEFAULT_TLD_BONUS } from '../weights.js';
import type { IntrinsicSignalConfig } from '../scoring-config.js';
import { DEFAULT_INTRINSIC_CONFIG } from '../scoring-config.js';

export function computeIntrinsicScore(
  input: ScoringInput,
  weight: number,
  config: IntrinsicSignalConfig = DEFAULT_INTRINSIC_CONFIG,
  tldBonuses: Record<string, number> = DEFAULT_TLD_BONUS,
): SignalOutput {
  // Engine always sets sld and tld before calling signal functions;
  // non-null assertion is safe here (see ScoringEngine.score()).
  const sld = input.sld!;
  const length = sld.length;

  const lengthScore =
    length <= config.idealLength
      ? 1.0
      : Math.max(0, 1 - (length - config.idealLength) / (config.maxLength - config.idealLength));

  const hyphenCount = (sld.match(/-/g) ?? []).length;
  const digitCount = (sld.match(/[0-9]/g) ?? []).length;
  const penaltyScore = Math.max(0, 1 - hyphenCount * 0.25 - digitCount * 0.15);

  const tldMultiplier = tldBonuses[input.tld!] ?? 0.3;

  const pronounceabilityScore = computePronounceability(sld);

  const raw =
    (lengthScore * 0.3 + penaltyScore * 0.35 + pronounceabilityScore * 0.35) * tldMultiplier;
  const score = Math.min(1, Math.max(0, raw));

  return {
    score,
    weight,
    dataAvailable: true,
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

const STRICT_VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

function computePronounceability(sld: string): number {
  const normalized = sld.toLowerCase();
  if (normalized.length === 0) return 0;

  const letters = [...normalized].filter((c) => /[a-z\u00C0-\u024F]/.test(c));
  if (letters.length === 0) return 0;

  let vowelCount = 0;
  let consonantClusterLength = 0;
  let maxCluster = 0;

  for (let i = 0; i < letters.length; i++) {
    const char = letters[i]!;
    const prev = i > 0 ? (letters[i - 1] ?? null) : null;

    if (STRICT_VOWELS.has(char)) {
      vowelCount++;
      consonantClusterLength = 0;
    } else if (char === 'y') {
      const precededByConsonant = prev !== null && !STRICT_VOWELS.has(prev) && prev !== 'y';
      if (precededByConsonant) {
        vowelCount++;
        consonantClusterLength = 0;
      } else {
        consonantClusterLength++;
        maxCluster = Math.max(maxCluster, consonantClusterLength);
      }
    } else {
      consonantClusterLength++;
      maxCluster = Math.max(maxCluster, consonantClusterLength);
    }
  }

  const vowelRatio = vowelCount / letters.length;
  const clusterPenalty = Math.max(0, (maxCluster - 3) * 0.2);
  const score = Math.min(1, Math.max(0, vowelRatio * 1.8 - clusterPenalty));
  return score;
}
