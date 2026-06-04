export interface TrademarkMatch {
  markName: string;
  owner: string;
  status: string;
  source: string;
  registrationNumber?: string | undefined;
}

export interface TrademarkProvider {
  search(term: string): Promise<TrademarkMatch[]>;
}
