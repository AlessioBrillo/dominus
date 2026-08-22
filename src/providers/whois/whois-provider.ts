// SPDX-License-Identifier: AGPL-3.0-only
export interface WhoisResult {
  domain: string;
  available: boolean;
  registrar?: string | undefined;
  createdDate?: string | undefined;
  expiryDate?: string | undefined;
  checkedAt: string;
}

export interface WhoisCheckOptions {
  /** When true, skip any persistent/in-memory cache and force a live lookup.
   *  Use for domains that may have recently changed status, such as
   *  closeout/expiring domains in the aftermarket. */
  forceRecheck?: boolean;
}

export interface WhoisProvider {
  checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: WhoisCheckOptions,
  ): Promise<WhoisResult>;
}
