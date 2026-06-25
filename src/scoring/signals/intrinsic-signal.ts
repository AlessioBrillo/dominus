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

/** Diphthongs: two vowels pronounced as a single vocalic unit. */
const DIPHTHONGS = new Set([
  'ai',
  'au',
  'ea',
  'ee',
  'ei',
  'ie',
  'oa',
  'oe',
  'oi',
  'oo',
  'ou',
  'ue',
]);
/** Pronounceable consonant digraphs: two+ letters that form a single phoneme. */
const PRONOUNCEABLE_CLUSTERS = new Set([
  'th',
  'sh',
  'ch',
  'ph',
  'ck',
  'ng',
  'gh',
  'wh',
  'wr',
  'kn',
  'qu',
  'dg',
  'tch',
]);

/**
 * Tokenise the string into a list where common English digraphs occupy a
 * single slot, so "th" is not counted as a consonant cluster of length 2.
 */
function tokenisePronounceability(input: string): string[] {
  const result: string[] = [];
  let i = 0;
  const chars = [...input.toLowerCase()];
  while (i < chars.length) {
    // Try 3-character cluster first (e.g. "tch")
    if (i + 2 < chars.length) {
      const triple = chars[i]! + chars[i + 1]! + chars[i + 2]!;
      if (triple === 'tch') {
        result.push('tch');
        i += 3;
        continue;
      }
    }
    // Try 2-character digraph
    if (i + 1 < chars.length) {
      const pair = chars[i]! + chars[i + 1]!;
      if (DIPHTHONGS.has(pair)) {
        result.push('V'); // treat as single vowel slot
        i += 2;
        continue;
      }
      if (PRONOUNCEABLE_CLUSTERS.has(pair)) {
        result.push('C'); // treat as single consonant slot
        i += 2;
        continue;
      }
    }
    result.push(chars[i]!);
    i++;
  }
  return result;
}

function computePronounceability(sld: string): number {
  const normalized = sld.toLowerCase();
  if (normalized.length === 0) return 0;

  const letters = [...normalized].filter((c) => /[a-z\u00C0-\u024F]/.test(c));
  if (letters.length === 0) return 0;

  const tokens = tokenisePronounceability(letters.join(''));

  let vowelCount = 0;
  let consonantClusterLength = 0;
  let maxCluster = 0;

  for (const token of tokens) {
    if (token === 'V') {
      vowelCount++;
      consonantClusterLength = 0;
    } else if (token === 'C') {
      consonantClusterLength++;
      maxCluster = Math.max(maxCluster, consonantClusterLength);
    } else if (STRICT_VOWELS.has(token)) {
      vowelCount++;
      consonantClusterLength = 0;
    } else if (token === 'y') {
      const precededByConsonant = consonantClusterLength > 0;
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
