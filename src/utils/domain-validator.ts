// SPDX-License-Identifier: AGPL-3.0-only
/**
 * @deprecated Import from `./domain.js` instead.
 *
 * This module existed before the domain utilities were consolidated.
 * All exports are re-exported from `./domain.js` — the single source
 * of truth for domain validation.
 */

export {
  type NormalizedDomain,
  normalizeDomain,
  isValidDomain,
  getSldForTrademark,
  extractSld,
  extractTld,
} from './domain.js';
