import { extractSld } from '../utils/domain.js';

export interface MatchCandidate {
  markName: string;
  owner: string;
  status: string;
  source: string;
}

/**
 * Conservative trademark matching (ADR-0012).
 *
 * The previous implementation used `sld.includes(mark) || mark.includes(sld)`,
 * which over-matched: `app.com` would block on the mark "Apple", and `bo.com`
 * would block on "Boss". The replacement is token-aware: we split both the
 * SLD and the mark on non-letters, normalise (lowercase + digit→word), and
 * require that every mark-token is "covered" by some SLD-token. Coverage
 * means one of:
 *
 *   1. exact equality post-normalisation
 *   2. the SLD token contains the mark token as a substring, but only when
 *      the mark token is at least 3 letters long (so a 2-letter mark like
 *      "bo" cannot match SLD token "bo" via inclusion of the SLD in the
 *      mark — which would have flipped the test cases the wrong way)
 *   3. Levenshtein distance ≤ 1, but only when both tokens are at least 4
 *      letters long. This catches obvious typo-squatters like
 *      `applle.com` vs the mark "Apple" without matching every 3-letter
 *      brand against every 3-letter mark.
 *
 * Compound marks such as "App Store" are split on whitespace/non-letters
 * and ALL of their tokens must be covered, so a bare `app.com` does NOT
 * match the mark "App Store".
 */

const DIGIT_WORDS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
};

/** Below this length we do not allow Levenshtein-1 matching. */
const MIN_TOKEN_LENGTH_FOR_FUZZY = 4;

/** Below this length we do not allow substring matching of a mark token. */
const MIN_MARK_TOKEN_LENGTH_FOR_SUBSTRING = 3;

/** Allow at most 1 substitution/insertion/deletion. */
const MAX_LEVENSHTEIN_DISTANCE = 1;

/**
 * SLD extraction is delegated to `extractSld` from `src/utils/domain.js`
 * (now backed by the full Public Suffix List per ADR-0015), ensuring the
 * scoring engine and the trademark gate agree on what counts as the SLD.
 */

function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[0-9]/g, (d) => DIGIT_WORDS[d] ?? d);
}

function tokenise(input: string): string[] {
  return normalise(input)
    .split(/[^a-z]+/u)
    .filter((t) => t.length > 0);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;
  const prev = new Array<number>(bLen + 1);
  const curr = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j++) prev[j] = j;
  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j <= bLen; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[bLen] ?? 0;
}

function isTokenClose(sldToken: string, markToken: string): boolean {
  if (sldToken === markToken) return true;
  if (
    sldToken.length > markToken.length &&
    sldToken.includes(markToken) &&
    markToken.length >= MIN_MARK_TOKEN_LENGTH_FOR_SUBSTRING
  ) {
    return true;
  }
  if (
    sldToken.length >= MIN_TOKEN_LENGTH_FOR_FUZZY &&
    markToken.length >= MIN_TOKEN_LENGTH_FOR_FUZZY &&
    Math.abs(sldToken.length - markToken.length) <= MAX_LEVENSHTEIN_DISTANCE &&
    levenshtein(sldToken, markToken) <= MAX_LEVENSHTEIN_DISTANCE
  ) {
    return true;
  }
  return false;
}

/**
 * Return the first mark that conflicts with the given SLD, or null when
 * the SLD is clear under the conservative token+Levenshtein policy.
 *
 * The function is O(marks × markTokens × sldTokens) per query. For the
 * volumes we deal with (≤ 50 hits per provider per SLD) this is well
 * within budget — no pre-indexing needed.
 */
export function detectMatch(
  domainSld: string,
  marks: MatchCandidate[],
): MatchCandidate | null {
  const sldTokens = tokenise(domainSld);
  if (sldTokens.length === 0) return null;

  for (const mark of marks) {
    const markTokens = tokenise(mark.markName);
    if (markTokens.length === 0) continue;

    let allCovered = true;
    for (const mt of markTokens) {
      let covered = false;
      for (const st of sldTokens) {
        if (isTokenClose(st, mt)) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        allCovered = false;
        break;
      }
    }
    if (allCovered) return mark;
  }

  return null;
}

/**
 * Extract the second-level label from a domain name using the full Public
 * Suffix List (ADR-0015). Delegated to `src/utils/domain.js` so the
 * scoring engine and the trademark gate share one implementation.
 */
export { extractSld };
