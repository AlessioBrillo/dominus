export enum BidStatus {
  Pending = 'pending',
  Won = 'won',
  Lost = 'lost',
  Cancelled = 'cancelled',
  Outbid = 'outbid',
}

export const BID_STATUSES: readonly BidStatus[] = [
  BidStatus.Pending,
  BidStatus.Won,
  BidStatus.Lost,
  BidStatus.Cancelled,
  BidStatus.Outbid,
] as const;

export function isBidStatus(value: unknown): value is BidStatus {
  return typeof value === 'string' && (BID_STATUSES as readonly string[]).includes(value);
}

export interface Bid {
  id?: number;
  domain: string;
  venue: string;
  bidAmountEur: number;
  maxBidEur?: number | undefined;
  status: BidStatus;
  wonPriceEur?: number | undefined;
  expectedValueAtBid?: number | undefined;
  confidenceAtBid?: number | undefined;
  suggestedBuyMaxAtBid?: number | undefined;
  trademarkClearAtBid?: boolean | undefined;
  bidPlacedAt: string;
  auctionEndsAt?: string | undefined;
  resolvedAt?: string | undefined;
  notes?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface PlaceBidInput {
  domain: string;
  venue: string;
  bidAmountEur: number;
  maxBidEur?: number | undefined;
  auctionEndsAt?: string | undefined;
  expectedValueAtBid?: number | undefined;
  confidenceAtBid?: number | undefined;
  suggestedBuyMaxAtBid?: number | undefined;
  trademarkClearAtBid?: boolean | undefined;
  notes?: string | undefined;
}

export interface ResolveBidInput {
  domain: string;
  status: BidStatus.Won | BidStatus.Lost | BidStatus.Cancelled | BidStatus.Outbid;
  wonPriceEur?: number | undefined;
  registrationYears?: number | undefined;
  notes?: string | undefined;
}

export function addYearsToDate(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

export interface BidSummary {
  bid: Bid;
  daysSincePlaced: number;
  portfolioEntryCreated: boolean;
}
