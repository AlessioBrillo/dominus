export interface ComparableSale {
  domain: string;
  salePrice: number;
  saleDate: string;
  venue: string;
}

export interface CompsProvider {
  getSales(term: string, signal?: AbortSignal): Promise<ComparableSale[]>;
}
