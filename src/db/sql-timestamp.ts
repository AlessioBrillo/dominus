// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UTC timestamp as `YYYY-MM-DD HH:MM:SS` — the exact text SQLite's
 * `CURRENT_TIMESTAMP` / `datetime('now')` produces, and a literal PostgreSQL
 * casts to both `timestamp` and `timestamptz` columns. Use it for cutoffs and
 * "now" parameters instead of dialect-specific `datetime(...)` arithmetic.
 */
export function sqlTimestamp(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

/** `sqlTimestamp` for `ms` milliseconds before now (negative = in the future). */
export function sqlTimestampAgo(ms: number): string {
  return sqlTimestamp(new Date(Date.now() - ms));
}
