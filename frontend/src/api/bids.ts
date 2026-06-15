import { api } from './client.js';
import type { Bid } from '../types/domain.js';

export interface PlaceBidRequest {
  domain: string;
  venue?: string;
  bidAmountEur: number;
  maxBidEur?: number;
  auctionEndsAt?: string;
  expectedValueAtBid?: number;
  confidenceAtBid?: number;
  suggestedBuyMaxAtBid?: number;
  trademarkClearAtBid?: boolean;
  notes?: string;
}

export interface ResolveBidRequest {
  domain: string;
  status: 'won' | 'lost' | 'cancelled' | 'outbid';
  wonPriceEur?: number;
  registrationYears?: number;
  notes?: string;
}

export function placeBid(input: PlaceBidRequest): Promise<{ bid: Bid }> {
  return api.post<{ bid: Bid }>('/bids/place', input);
}

export function resolveBid(input: ResolveBidRequest): Promise<{ bid: Bid }> {
  return api.post<{ bid: Bid }>('/bids/resolve', input);
}

export function listBids(status?: string): Promise<{ bids: Bid[] }> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return api.get<{ bids: Bid[] }>(`/bids${query}`);
}

export function listPendingBids(): Promise<{ bids: Bid[] }> {
  return api.get<{ bids: Bid[] }>('/bids/pending');
}

export function getBid(domain: string): Promise<{ bid: Bid }> {
  return api.get<{ bid: Bid }>(`/bids/${encodeURIComponent(domain)}`);
}
