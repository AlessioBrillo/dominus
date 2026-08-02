// SPDX-License-Identifier: AGPL-3.0-only
export interface ComparableSale {
  domain: string;
  salePrice: number;
  saleDate: string;
  venue: string;
}

export interface CompsProvider {
  getSales(term: string, signal?: AbortSignal): Promise<ComparableSale[]>;
}
