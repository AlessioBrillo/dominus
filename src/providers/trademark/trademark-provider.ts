// SPDX-License-Identifier: AGPL-3.0-only
export interface TrademarkMatch {
  markName: string;
  owner: string;
  status: string;
  source: string;
  registrationNumber?: string | undefined;
}

export interface TrademarkProvider {
  search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]>;
}
