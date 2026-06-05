import type { CloseoutEntry } from '../types/candidate.js';

/**
 * Parses a closeout/expiry CSV into candidate entries.
 *
 * This module lives at the application edge — it owns parsing/validation of an
 * external file format and produces plain {@link CloseoutEntry} values. The pure
 * `pipeline/` stages never read files; the caller reads the file and passes the
 * content here.
 *
 * Format (header-driven, column order is free; unknown columns are ignored):
 *   - `domain`   (required) — the closeout domain name
 *   - `age`      (optional) — domain age in years
 *   - `backlinks`(optional) — referring-domain / backlink count
 *   - `wayback`  (optional) — number of Wayback Machine snapshots
 *
 * Rows whose `domain` is missing or not a syntactically valid DNS name are
 * skipped rather than throwing, so one bad line never aborts a whole import.
 * Blank lines and `#`-prefixed comment lines are ignored.
 */

// RFC-1123-ish hostname check: 1+ labels then a TLD, ≤253 chars total, each
// label 1-63 chars of [a-z0-9-] not starting/ending with a hyphen.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function isValidDomain(value: string): boolean {
  return DOMAIN_RE.test(value.toLowerCase());
}

/** Parse a column to a finite, non-negative number, or undefined if absent/invalid. */
function parseNonNegative(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function splitRow(line: string): string[] {
  return line.split(',').map((cell) => cell.trim());
}

export function parseCloseoutCsv(content: string): CloseoutEntry[] {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  if (lines.length < 2) return [];

  const header = splitRow(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = {
    domain: header.indexOf('domain'),
    age: header.indexOf('age'),
    backlinks: header.indexOf('backlinks'),
    wayback: header.indexOf('wayback'),
  };

  if (col.domain === -1) return [];

  const entries: CloseoutEntry[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    const domain = (cells[col.domain] ?? '').toLowerCase();
    if (!isValidDomain(domain)) continue;

    entries.push({
      domain,
      domainAge: col.age === -1 ? undefined : parseNonNegative(cells[col.age]),
      backlinks: col.backlinks === -1 ? undefined : parseNonNegative(cells[col.backlinks]),
      waybackSnapshots: col.wayback === -1 ? undefined : parseNonNegative(cells[col.wayback]),
    });
  }

  return entries;
}
