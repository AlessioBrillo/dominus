// SPDX-License-Identifier: AGPL-3.0-only
/** The alert topics a mobile user can opt into independently (ADR-0116). */
export interface UserConfigurableTopics {
  renewal: boolean;
  watchlist: boolean;
  verdict: boolean;
}
