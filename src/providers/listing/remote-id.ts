// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers for the HTTP marketplace adapters (dan/afternic/sedo).
 *
 * Remote marketplaces use string ids (`sd-1001`, `af-999`) while the local
 * `Listing`/`ListingOffer` types carry numeric ids. `parseInt()` on a
 * string id yields NaN and silently breaks the sync offer linkage, so
 * every adapter maps through {@link safeRemoteNumericId}: numeric ids stay
 * stable, string ids fall back to a deterministic hash (equal input maps
 * to equal output, so offers still group onto their listing).
 */
export const MAX_SYNC_PAGES = 50;

export function safeRemoteNumericId(externalId: string): number {
  const parsed = parseInt(externalId, 10);
  if (Number.isFinite(parsed)) return parsed;
  let hash = 0;
  for (let i = 0; i < externalId.length; i++) {
    hash = (hash * 31 + externalId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
