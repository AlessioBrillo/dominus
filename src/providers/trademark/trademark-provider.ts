export interface TrademarkMatch {
  markName: string;
  owner: string;
  status: string;
  source: string;
  registrationNumber?: string;
}

export interface TrademarkProvider {
  search(term: string): Promise<TrademarkMatch[]>;
}
