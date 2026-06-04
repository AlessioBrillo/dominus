export interface MatchCandidate {
  markName: string;
  owner: string;
  status: string;
  source: string;
}

function normalizeTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/[0-9]/g, (d) => DIGIT_WORDS[d] ?? d)
    .replace(/[^a-z]/g, '');
}

const DIGIT_WORDS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
};

export function detectMatch(
  domainSld: string,
  marks: MatchCandidate[],
): MatchCandidate | null {
  const normalizedSld = normalizeTerm(domainSld);

  for (const mark of marks) {
    const normalizedMark = normalizeTerm(mark.markName);
    if (normalizedSld === normalizedMark || normalizedSld.includes(normalizedMark) || normalizedMark.includes(normalizedSld)) {
      return mark;
    }
  }

  return null;
}

export function extractSld(domain: string): string {
  const parts = domain.split('.');
  if (parts.length < 2) return domain;
  return parts.slice(0, parts.length - 1).join('');
}
