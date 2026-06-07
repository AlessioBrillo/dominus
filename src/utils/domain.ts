/**
 * Domain-name validation.
 *
 * Centralised so the same rule applies at every entrypoint (closeout CSV
 * import, `dominus score` CLI, future REST validators, etc.).
 *
 * Rule (RFC-1123-ish, ASCII-only, the common case DOMINUS cares about):
 *   - total length 1..253
 *   - one or more labels separated by dots
 *   - each label 1..63 chars of [a-z0-9-] not starting or ending with '-'
 *   - the rightmost label (TLD) is at least 2 letters
 *
 * Lower-case normalisation is the caller's responsibility. We accept
 * mixed case via the test (lowercasing happens here too).
 */

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function isValidDomain(value: string): boolean {
  return DOMAIN_RE.test(value.toLowerCase());
}
